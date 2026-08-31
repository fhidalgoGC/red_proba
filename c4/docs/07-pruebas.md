# 07 · Pruebas

```bash
npm test                # unitarias + integración contra Postgres
npm run e2e             # punta a punta: KMS real, cola real, Postgres real
npm run e2e -- --lento  # + reentrega real de SQS (~90 s)
```

**41 tests** en verde, más el punta a punta.

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
tamaños sorteados en `[2048, 4096]`) y **6 venenos, uno por cada guarda**:

| Veneno | Motivo esperado | Qué guarda ataca |
|---|---|---|
| el cuerpo no es un sobre | `no_es_sobre` | Alguien más publicando en la cola |
| ciphertext alterado | `no_descifra` | El tag de GCM |
| descifra pero la firma no cubre el documento | `firma_invalida` | **El caso grave: inyección con la llave de cifrado** |
| `key_id` fuera de la lista blanca | `llave_no_aceptada` | Firmado con otra llave |
| `payload_hash` declarado ≠ recalculado | `payload_hash_no_coincide` | Idempotencia, o deriva del JCS |
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
     5 · payload_hash_no_coincide
     5 · rpf_id_invalido
```

## El health se prueba en falso, a propósito

`test/salud.test.ts` levanta el endpoint con una base **de mentira** que
contesta lo que el test le diga. Lo que se afirma no es que devuelva 200 —eso lo
haría cualquier servidor— sino que `ok` **sigue a la base**: con la base
respondiendo `false`, el health dice `ok:false`, y cada llamada consulta de
verdad en vez de devolver un valor fijo. Contra un Postgres real ese caso no se
puede provocar sin tirar el contenedor.

También fija dos cosas que no son de configuración: que `puede_firmar` es
siempre `false` (regla 7) y que en ese módulo cualquier otra ruta es un 404 — la
frontera que cuida es que **el ledger no se consulte por HTTP**.

## `GET /logs/:id` sirve un archivo, no la base

`test/logs.test.ts` clava lo que ese endpoint no puede hacer. No monta base de
mentira **porque el controlador no la pide**: si algún día se la pidiera, el test
no compilaría, y esa es la barrera que interesa — `G-10` sirve el volcado que ya
escribió el CLI de `G-08`, no una consulta a Postgres.

Lo demás es el borde de un id que llega de fuera y se concatena a una ruta: que
no pueda salirse de la carpeta (`../`, espacios, un `NUL`), que un **directorio**
con nombre de log no se sirva como si fuera un JSON —`statSync` no falla ahí, así
que sin `isFile()` saldría un `EISDIR` a medio download—, y que el 404 diga qué
ids sí hay y que el volcado lo produce el CLI. Un 404 pelado se lee como «no
llegó nada» cuando lo que falta es haber corrido el informe.

Y **el orden de los candidatos, que es el contrato**: con los dos archivos
presentes, `/logs/<id>` tiene que dar el log por segundo (`<id>__c4.json`) y no
el volcado del ledger, porque `/logs/<id>` significa «el log» en los tres
contenedores. `/logs/<id>__inbox` da el otro. Y si todavía no hay log por
segundo, `/logs/<id>` sigue dando el volcado: quien ya tiene ese `curl` en un
script no debería empezar a recibir 404.

## `G-11` · las métricas por segundo

`test/metricas.test.ts` — sin cola, sin KMS y sin Postgres: aquí solo hay
aritmética y forma de archivo. Los tramos que necesitan una base (`inbox`,
`stamp`) se ejercitan en `inbox.test.ts` y en el punta a punta.

Lo que defiende, y por qué cada cosa:

| | Si se rompiera |
|---|---|
| `received`, `init` y `completed` son **tres relojes distintos** | fue el fallo real: con `init` saliendo del reloj del lote, cada fila decía `50 / 50` un segundo tras otro y el informe parecía inventado |
| `empieza()` mueve `messages.init` y `message.init` **a la vez** | podrían derivar y el archivo diría que empezaron 50 mensajes y que el tramo arrancó 41 veces, sin forma de saber cuál miente |
| `crossed` cuenta las que cerraron aquí habiendo empezado antes | es lo único que distingue «los mismos 50» de «otros 50»; sin él hay que creerse el par `init`/`completed` |
| `wait` y `receive` se declaran `observado` | son huecos ya ocurridos: sus columnas coinciden por definición, y sin la bandera se leen como un reloj plano y falso |
| `min_ms` y `max_ms` son exactos y el techo **no** los toca | son la prueba, dentro de la fila, de que cada ejecución se midió sola: `min = max` con `n` grande es medir una vez y repetirla |
| un veneno deja `message.init` sin su `completed` | un descarte sería indistinguible de un éxito, y se perdería en qué paso murió |
| el id de corrida separa los archivos | C4 es **uno** para los 50 tenants: dos pruebas seguidas caerían en el mismo archivo y P2 de la segunda saldría inflada |
| un id con forma rara acaba en `sin-id` | a diferencia de C3, aquí el id no llega en una cabecera propia: llega en un `MessageAttribute` **en claro** de una cola, y acaba en un nombre de archivo del operador neutro |
| las reentregas se cuentan y **no** son un error | la entrega es al-menos-una-vez (regla 4); marcarlas como fallo haría que P4 pareciera rota justo cuando funciona |
| un sondeo en vacío **no** mantiene viva una corrida | el lazo sondea para siempre: el informe nunca se cerraría, `duracion_s` crecería sin parar y habría una fila por cada 20 s de cola vacía. Medido antes de arreglarlo: una corrida de 10 s con **259 s** de duración |
| el techo de muestras recorta los percentiles pero **no** `n`, `suma` ni `max` | en C4 no es hipotético —se alcanza pasando de 500 msg/s— y `envelope+decrypt+verify+hash+inbox` dejaría de dar `message` justo en las corridas grandes |

El punta a punta lo comprueba **con la cola de verdad**: que el id de corrida
viajó dentro del `MessageAttribute` (si no, el archivo que busca no existiría) y
que la suma de los cinco tramos del mensaje cuadra con `message`. Medido sobre
725 mensajes reales: **0,000 % de desvío**.
