# C4 — documentación del track `G`

El **operador neutro**. Consume de la cola FIFO, descifra, verifica la firma y
persiste.

Termina cuando el evento queda guardado en el Postgres de C4 — ese COMMIT es
`e10`, **el final de la medición**.

> **[Diagramas](diagramas.html)** — el mecanismo explicado etapa por etapa, con
> siete diagramas. Es un HTML autocontenido: ábrelo desde el disco, sin
> servidor ni conexión. También publicado en
> [claude.ai](https://claude.ai/code/artifact/80828c05-58ef-4586-9ad8-80bb80d0a344).

---

## Los documentos

| | Qué responde |
|---|---|
| [01 · Cómo funciona](01-como-funciona.md) | El camino de un mensaje, paso a paso, y dónde puede salirse |
| [02 · Criptografía](02-criptografia.md) | Qué descifra KMS y qué no, y por qué la firma se verifica en local |
| [03 · La base](03-base.md) | El inbox, los cinco schemas, los descartes y las consultas que responden P4 |
| [04 · Medición](04-medicion.md) | `e7..e10`, la marca `e7b` que hubo que añadir, el log por segundo (`G-11`) y los números medidos |
| [05 · Configuración](05-configuracion.md) | Variables de entorno, y cuál de ellas es de seguridad y no de config |
| [06 · Reglas que no se negocian](06-reglas.md) | Las decisiones que si se rompen invalidan la prueba |
| [07 · Pruebas](07-pruebas.md) | Cómo se prueba contra KMS, cola y Postgres reales |
| [Diagramas](diagramas.html) | El mecanismo dibujado — abrir en el navegador |

El **diseño** del track vive aparte, en
[../../docs/05-contenedor-c4.md](../../docs/05-contenedor-c4.md). Esto es la
implementación.

---

## Arranque rápido

```bash
npm ci && npm run build

npm start        # lee c4/.env con `node --env-file=.env`
```

Toda la configuración vive en **`c4/.env`** (plantilla en `.env.ejemplo`), que
carga Node de forma nativa — sin `dotenv`. Lo que la línea de comandos ponga
gana sobre el archivo, así que se puede pisar cualquier variable sin editarlo:

```bash
C4_SALIR_TRAS_VACIOS=2 npm start     # termina solo al vaciarse la cola
```

### ⚠ Base propia, separada de las de C3

```
rpf_c4              ← C4
rpf_c3_tenant01     ← C3 tenant-01
rpf_c3_tenant02     ← C3 tenant-02
```

No es una preferencia de orden. **C3 y C4 son dominios sin ruta de red entre
ellos** (D-03) y el único canal es la cola. Si compartieran base, una
conciliación con `JOIN c3.outbox … c4.inbox` funcionaría en local y sería
**imposible en producción** — la peor clase de prueba: la que da verde por una
razón que no existe fuera del portátil.

Conciliar outbox contra inbox se hace **exportando de cada base por separado y
cruzando fuera**, que es lo único que se podrá hacer en AWS:

```bash
psql -d rpf_c3_tenant01 -tAc "SELECT payload_hash FROM c3.outbox WHERE status='SENT'" > t01.txt
psql -d rpf_c4          -tAc "SELECT payload_hash FROM c4.inbox"                      > c4.txt
# se comparan como conjuntos, fuera de las bases
```

**Sigue sin ser un API.** La cola es su única entrada y el Postgres su única
salida. Lo que sirve por HTTP es su salud (`G-09`) y **archivos** (`G-10`) —
nunca una consulta al ledger:

```bash
curl localhost:3003/health              # ok, base, cola, estado del consumidor
curl localhost:3003/status              # contadores del proceso + métricas por corrida
curl -OJ localhost:3003/logs/<id>          # el log por segundo   (G-11)
curl -OJ localhost:3003/logs/<id>__inbox   # el volcado del ledger (G-08)
open  http://localhost:3003/docs        # Swagger
```

Hay **dos archivos por corrida y no son lo mismo**: `<id>__c4.json` es el reloj
del consumidor, escrito desde memoria mientras llega tráfico, y contesta
P1/P2/P3; `<id>__inbox.json` es el volcado del ledger que deja
`npm run informe -- --prueba <id>`, y contesta la mitad «llegó» de P4.

`/logs/<id>` **no consulta la base** en ninguno de los dos casos: abre un archivo
de disco y lo sirve como adjunto. El ledger sigue sin consultarse por HTTP.

Ese endpoint existe porque **un proceso vivo no dice nada**: C4 puede estar
corriendo con el Postgres caído y seguir sacando mensajes de la cola — los
borraría sin persistir y P4 daría de menos, sin un solo error visible desde
fuera. Por eso `ok` refleja **la base**, no el proceso, igual que en C3 (C-08).

Documentado en Swagger, como C3 y el orquestador: **`http://localhost:3003/docs`**.

Escucha en `127.0.0.1`, así que la task definition de `terraform/modules/c4`
sigue **sin `portMappings` y sin balanceador** — el único que lo consulta es el
`healthCheck` de la propia task, desde dentro del contenedor. Y con
`C4_PORT=0` arranca como contexto puro, sin abrir nada: exactamente como corría
antes de `G-09`.

---

## Estado

| Tarea | |
|---|---|
| `G-01` Consumidor FIFO con long polling | ✅ |
| `G-02` Descifrado y verificación, en ese orden | ✅ |
| `G-03` Inbox e idempotencia | ✅ |
| `G-04` Proyección a los cinco schemas | ✅ |
| `G-05` Detección de huecos | ✅ |
| `G-06` Marcas de tiempo `e7..e10` | ✅ (+ `e7b`) |
| `G-07` Manejo de DLQ | ✅ |
| `G-08` Volcado del inbox para conciliar | ✅ (`npm run informe -- --prueba <id>`) |
| `G-09` Endpoint de salud (`/health`, `/status`) | ✅ |
| `G-10` Descarga de archivos (`GET /logs/<id>`) | ✅ (sirve archivos, no consulta la base) |
| `G-11` Log por segundo, con `init`/`completed` por paso | ✅ (`c4/logs/<prueba>__c4.json`) |

---

## En una frase

Toma lotes de diez de una cola FIFO, le pide a KMS **una llave** —no el
documento—, abre el sobre en local, comprueba con una clave pública cacheada
que la firma cubre exactamente lo que va a guardar, y escribe el inbox y los
cinco schemas **en una sola transacción**; lo que no abre o no verifica sale de
la cola en el acto y va a la DLQ con alarma, porque dejarlo congelaría su
expediente entero durante cinco minutos.
