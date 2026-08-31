# 05 — Contenedor consumidor (C4)

El operador neutro. Consume de la cola, descifra, verifica y persiste.

**Termina cuando el evento queda guardado en el Postgres de C4** — ese COMMIT
es `e10`, el final de la medición.

**Invariante**: C4 descifra pero **nunca puede firmar**. Su rol de IAM no tiene
`kms:Sign` sobre la llave Ed25519 de C3, y la key policy de esa llave lo niega
explícitamente.

## Tareas

### G-01 · Consumidor FIFO con long polling

Recepción por lotes de 10, borrado solo tras procesar.

⚠ **Límite de 20.000 mensajes en vuelo** en una cola FIFO. Si te atrasas, la
cola deja de entregar con `OverLimit` y el síntoma parece que se vació, cuando
en realidad está llena.

### G-02 · Descifrado y verificación, en ese orden

1. `Decrypt` de la `edk` del sobre → data key.
2. AES-256-GCM con `iv` y `tag` → `{ payload, signature }`.
3. Canonizar el `payload` con **el mismo JCS** que usó C3.
4. Verificar la firma Ed25519 con la llave pública de C3.

> Un sobre que **descifra pero cuya firma no verifica** es más grave que uno que
> no descifra: significa que alguien con la llave de cifrado intentó inyectar.
> Ese caso va a la DLQ **con alarma**, no al reintento normal.

### G-03 · Inbox e idempotencia  ⚠ CRÍTICO

La entrega es al-menos-una-vez: **los duplicados no son una anomalía, son parte
del contrato**. El relay reintenta y eso es funcionamiento normal.

```sql
CREATE TABLE inbox (
  payload_hash        TEXT PRIMARY KEY,       -- la clave de idempotencia
  rpf_id          UUID NOT NULL,
  sequence        INT  NOT NULL,
  duplicado       BOOLEAN NOT NULL DEFAULT false,
  e7_recibido     TIMESTAMPTZ,
  e8_descifrado   TIMESTAMPTZ,
  e9_verificado   TIMESTAMPTZ,
  e10_persistido  TIMESTAMPTZ            -- DESPUÉS del COMMIT, no del INSERT
);
```

```sql
INSERT INTO inbox (payload_hash, rpf_id, sequence, ...)
VALUES (...)
ON CONFLICT (payload_hash) DO NOTHING
RETURNING payload_hash;   -- vacío = era duplicado
```

Si ya estaba: se registra el duplicado en el contador y se borra el mensaje.
**Sin esto, cada reintento del relay duplica un asiento fiscal.**

### G-04 · Proyección a los cinco schemas

Journal (append-only), Shared Map, Case Header, Policy Registry, Key Registry.
Es lo que convierte el evento en estado consultable.

### G-05 · Detección de huecos

El `sequence` por `rpf_id` permite ver si falta un evento intermedio. Con FIFO
no debería ocurrir nunca — y por eso vale medirlo: **un solo hueco invalida la
afirmación de orden** y es un hallazgo mucho más grave que una latencia alta.

⚠ **Esto solo ve huecos INTERIORES**, y esa limitación no se arregla desde aquí:
el rango con el que compara sale de los propios datos que llegaron, así que una
cabeza ausente desplaza el `MIN`, una cola ausente desplaza el `MAX` y un
expediente perdido entero no deja ni fila que agrupar. C4 no puede saber cuántos
eventos tenía que llevar un expediente. Lo cierra el manifiesto del orquestador
(O-08) cruzado con G-08.

### G-08 · Volcado del inbox para conciliar

```bash
npm run informe -- --nombre <prueba> --desde <ISO>
```

Escribe `c4/logs/<prueba>__inbox.json`: por expediente, los `sequence` que
llegaron comprimidos en rangos, más los duplicados. **No decide si falta algo**
—no puede saberlo— solo dice qué tiene, en un formato que el manifiesto pueda
restar.

Es un CLI y no un endpoint a propósito: la única entrada de C4 es la cola
(D-03). Abrirle un puerto HTTP para consultar informes le añadiría, en la cuenta
del operador neutro, una superficie que el diseño no contempla. El `/health` de
`G-09` no es una excepción a esto: no sirve un solo dato del ledger —ni un
`rpf_id`, ni un `payload_hash`, ni un importe—, solo si el proceso ve su base.
Los informes siguen saliendo por CLI.

⚠ `--desde` corta por `e7_recibido`. La base sobrevive a la corrida: sin corte,
el volcado arrastra los expedientes de pruebas anteriores y la conciliación los
reporta como desconocidos por centenares.

### G-06 · Marcas de tiempo e7..e10

Ver [07-medicion](07-medicion.md). `e10` se estampa **después del COMMIT**, no
cuando el `INSERT` retorna: si lo estampas antes, te pierdes justo la parte que
puede volverse lenta bajo carga.

### G-07 · Manejo de DLQ

Separar dos casos, que son distintos:

| Caso | Acción |
|---|---|
| No descifra / no verifica | DLQ **con alarma**. Posible inyección. |
| Falla la proyección | Reintento normal, luego DLQ. |

### G-09 · Endpoint de salud

C4 responde `GET /health` y `GET /status`, como C3 (`C-08`) y el orquestador.

**Por qué, si es un worker.** Porque un proceso vivo no dice nada. C4 puede
estar corriendo con el Postgres caído y seguir sacando mensajes de la cola: los
borraría sin persistir, y P4 daría de menos sin un solo error visible desde
fuera. Por eso `ok` refleja **la base**, no el proceso — el health consulta de
verdad, igual que el de C3.

Ninguna otra señal sirve para esto:

| Señal | Qué prueba |
|---|---|
| El pid vive | Que el proceso existe. Nada más |
| El puerto escucha | Que alguien hizo `listen` |
| `psql` desde fuera | Que Postgres está vivo, **no** que C4 pueda entrar: credenciales, `DATABASE_URL` o pool agotado dan verde aquí y rojo dentro |
| `GET /health` | Proceso vivo **y** base alcanzable desde la aplicación, con sus credenciales |

**Sin volverlo un API.** Nest con Swagger en `/docs`, igual que C3 y el
orquestador —los tres se preguntan y se leen del mismo modo—, y lo publicado son
`/health`, `/status` y `GET /logs/<id>`. **El ledger no se consulta por HTTP:**
`/logs/<id>` sirve **archivos ya escritos en disco**, no una consulta a
Postgres. El volcado del ledger lo escribe el CLI de `G-08` y si nadie lo corrió
contesta 404; lleva `rpf_id` dentro —es la mitad «llegó» de P4— pero ni
`payload_hash`, ni el documento en claro, ni un importe: el que decide qué se
expone sigue siendo el CLI, no el endpoint.

Escucha en `127.0.0.1`, así que la task definition sigue **sin `portMappings` y
sin balanceador**: quien lo consulta es el `healthCheck` de la propia task,
desde dentro del contenedor. Con `C4_PORT=0` arranca como contexto puro y no
abre nada — como corría antes de `G-09`.

⚠ El `healthCheck` de ECS comprueba **`ok:true` en el cuerpo**, no el código
HTTP: el endpoint contesta 200 también con la base caída, con `ok:false` dentro.

### G-11 · Log por segundo, con `init`/`completed` por paso

C4 lleva su propio reloj en memoria y lo vuelca a `c4/logs/<prueba>__c4.json`,
con la misma forma que el log de C3 (`C-09`) y el del orquestador: total,
`seconds[]`, y `minutes[]` cuando la corrida pasa de un minuto.

**Por qué no bastan las marcas `e7..e10`.** Son ISO 8601, con resolución de
milisegundo. Verificar Ed25519 sobre 3 KB es sub-milisegundo y el AES-GCM del
sobre también: los dos tramos saldrían en `0 ms` y el informe diría que descifrar
y verificar son gratis. Las muestras se toman con `hrtime.bigint()` —monótono y
con resolución de nanosegundo—. Las marcas siguen siendo las que van a las
columnas y las que permiten conciliar contra el outbox de C3; esto es lo otro:
**duración, no instante**.

**Y por qué hace más falta aquí que en C3.** C4 es el **embudo**: los 50 tenants
publican a una cola y este proceso la consume solo, en serie dentro de cada lote.
Si algo se satura primero —P3— se satura aquí, y un promedio por minuto lo
escondería.

**Doce tramos**, cada uno con su par `init`/`completed`:

| | Por mensaje | Por lote | Por ciclo |
|---|---|---|---|
| | `wait` `envelope` `decrypt` `verify` `hash` `inbox` `message` | `stamp` `delete` `batch` | `receive` |

(más `dlq`, que solo se ejecuta en el camino del veneno y se cronometra aparte:
metido en `message` inflaría la latencia media con dos viajes de red que a un
mensaje sano no le pasan).

`init` cae en el segundo en que el tramo **empezó** y `completed` en el que
**terminó**. Que no coincidan es lo normal y es el dato: `init − completed` son
las ejecuciones que entraron y no salieron, y dicen **en qué paso** se quedó un
mensaje que nunca llegó a `e10`. Un veneno de firma inválida deja `verify.init`
sin su `completed` e `inbox.init` sin tocar.

La aritmética cuadra en el total, no en una fila suelta:

```
envelope + decrypt + verify + hash + inbox  =  message
Σ message + stamp + delete                  =  batch
```

`wait` queda fuera de esa suma a propósito —es espera, no trabajo (`e7→e7b`)— y
sumarlo contaría dos veces el procesamiento de los mensajes anteriores del lote.
Medido sobre 725 mensajes reales, el desvío en el total es **0,000 %**.

**El id de corrida cruza el único canal que hay.** El archivo se llama
`<prueba>__c4.json` y esa `<prueba>` sale del `MessageAttribute` `prueba` del
mensaje SQS, que escribe el relay de C3 copiando el `x-prueba-id` del
orquestador. Va **fuera del payload** porque el payload va firmado (regla 8) y
porque el id de una prueba no pertenece a un asiento fiscal que guarda el
operador neutro. Sin él, dos corridas seguidas caerían en el mismo archivo y P2
de la segunda saldría inflada. El mismo id se guarda en `inbox.prueba`, y es lo
que hace exacto el `--prueba` de `G-08`.

Detalle y una corrida completa medida:
[c4/docs/04-medicion.md](../c4/docs/04-medicion.md#g-11--el-log-por-segundo).
Mirar solo el código dejaría la task en verde justo en el caso que este health
existe para detectar.
