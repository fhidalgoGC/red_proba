# 07 · Pruebas

```bash
npm test                # unitarias + integración contra Postgres
npm run e2e             # punta a punta: KMS real, cola real, Postgres real
npm run e2e -- --lento  # + reentrega real de SQS (~90 s)
```

**26 tests** en verde, más el punta a punta.

---

## El productor hace de C3 sin tocar C3

`test/productor.ts` firma con la llave Ed25519 **real** de la PoC, cifra con
una data key **real** de la llave simétrica de C4, y publica en la cola FIFO
**real**. Produce exactamente los bytes que C4 se va a encontrar en producción.

**No es C3 ni pretende serlo.** No hay outbox, no hay relay, no hay transacción
de negocio, no hay marcas `e0..e6`. Es el mínimo que hace falta para que C4
tenga algo legítimo que abrir — y, sobre todo, algo **ilegítimo** con lo que
probar `G-07`.

Lo único simulado es el Postgres, que en local es un contenedor con su propio
esquema. Probar el descifrado contra un KMS de mentira no probaría el
descifrado.

---

## Los seis venenos

El punta a punta publica 12 documentos legítimos (3 expedientes × 4 eventos,
tamaños sorteados en `[1536, 3072]`) y **6 venenos, uno por cada guarda**:

| Veneno | Motivo esperado | Qué guarda ataca |
|---|---|---|
| el cuerpo no es un sobre | `no_es_sobre` | Alguien más publicando en la cola |
| ciphertext alterado | `no_descifra` | El tag de GCM |
| descifra pero la firma no cubre el documento | `firma_invalida` | **El caso grave: inyección con la llave de cifrado** |
| `key_id` fuera de la lista blanca | `llave_no_aceptada` | Firmado con otra llave |
| `payload_hash` declarado ≠ recalculado | `dedup_no_coincide` | Idempotencia, o deriva del JCS |
| `rpf_id` que no es UUID | `rpf_id_invalido` | Reintento infinito por dato inválido |

> **Que el total cuadre no basta.** Se comprueba que cada uno cayó **por su
> motivo**. Dos venenos rechazados por el motivo equivocado darían el mismo
> total de descartes y esconderían que una de las dos guardas no funciona.

---

## Lo que el punta a punta afirma

```
✔ P4 · llegaron los 12 legítimos (inbox=12)
✔ el journal tiene 12 asientos (12)
✔ todos tienen e10 (sin_e10=0)
✔ 3 expedientes en case_header (3)
✔ G-05 · sin huecos de sequence (0)
✔ G-07 · 6 descartes anotados, los 6 con alarma
✔ nada quedó para reintentar (0)
✔ los 12 se descifraron Y se verificaron
✔ el payload guardado es byte a byte el firmado (12/12)
```

El último merece explicación: se recanoniza lo que quedó en el `journal` y se
compara con el documento original. Si no cuadrara, estarías guardando algo
distinto de lo que la firma cubre — y ninguno de los otros checks lo habría
notado.

---

## La reentrega real (`--lento`)

Un duplicado de verdad llega cuando **SQS reentrega**, y eso ocurre al vencer
el visibility timeout: 60 segundos en la cola de la PoC.

```
publicar 1 evento
correr C4 con C4_BORRAR=false     →  persiste 1, no borra
esperar 65 s                      →  vence el visibility timeout
correr C4 normal                  →  el mensaje vuelve
```

Resultado:

```
✔ reentrega · sigue habiendo UNA fila de inbox
✔ reentrega · el duplicado se contó (duplicados=1)
✔ reentrega · el journal NO duplicó el asiento
```

**Por qué hay además un test rápido de lo mismo.** `test/inbox.test.ts` ejerce
el mismo camino de código —`persistir()` dos veces con el mismo `payload_hash`— en
milisegundos. Probar la idempotencia esperando un minuto por caso convierte la
suite en algo que nadie corre; el lento comprueba aparte que la reentrega
ocurre de verdad.

---

## El test que más importa

`test/jcs.test.ts` compara `src/comun/jcs.ts` con
`../orquestador/src/generador/jcs.ts` y **falla si divergen**.

Son la misma implementación duplicada. Si una deriva, el síntoma no es «hay dos
copias»: es que la firma deja de verificar y C4 manda todo a la DLQ con alarma
— **indistinguible de un intento de inyección**. Este test convierte una deriva
silenciosa en un fallo ruidoso.

> Su primera versión anclaba las rutas en `__dirname`, que compilado apunta
> dentro de `dist-test/`. No resolvían, y el test **se saltaba en silencio** —
> que es exactamente la forma en que un guardia de deriva deja de guardar.
> Ahora ancla en `process.cwd()` y falla si el archivo no está.

---

## Herramienta de DLQ

```bash
node dist-test/test/drenar-dlq.js            # solo lista, agrupado por motivo
node dist-test/test/drenar-dlq.js --borrar   # lista y vacía
```

Vive **aparte** del consumidor a propósito. C4 mira la profundidad de la DLQ
pero nunca la consume.

```
30 mensajes borrados:
     5 · no_es_sobre
     5 · no_descifra
     5 · firma_invalida
     5 · llave_no_aceptada
     5 · dedup_no_coincide
     5 · rpf_id_invalido
```
