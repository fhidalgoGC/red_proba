# c3 — Contenedor del cliente (track `C`)

NestJS. **Una sola imagen sirve a los 50 tenants**; todo lo que cambia son
variables de entorno (D-07).

El API y el relay del outbox viven en el **mismo proceso**. No son dos
contenedores ni dos services.

Doc de referencia: [../docs/03-contenedor-c3.md](../docs/03-contenedor-c3.md)

> **[Documentación completa en `docs/`](docs/README.md)** — ocho documentos: el
> pipeline, el contrato de atributos, la criptografía, el outbox, el relay, la
> configuración, la medición y las reglas.
>
> **Diagramas** — [`docs/diagramas.html`](docs/diagramas.html) (HTML
> autocontenido, se abre desde el disco) · publicado en
> [**claude.ai**](https://claude.ai/code/artifact/6048693b-e9d9-45d1-9b8b-e2c8ab048a37)

> **ESTADO: el camino está completo.** Valida y canoniza (`C-02`), firma
> (`C-03`), cifra (`C-04`), escribe el outbox en la transacción de negocio
> (`C-05`) y **el relay lo publica en la cola FIFO de C4 (`C-06`)**.
>
> Verificado de punta a punta con KMS, SQS y Postgres reales:
> **803 ofrecidos → 803 en el outbox → 803 en el inbox de C4 → 0 perdidos.**
>
> **⚠ CAMBIO DE DISEÑO: C3 ya no genera.** El orquestador construye los
> documentos. C3 recibe `{ lote_id, tenant_id, documentos: [...] }` y arranca
> en el Canonical Mapper. **`POST /events/generar` se eliminó**: `POST /events`
> es la única entrada.
>
> Los eventos llegan con **tamaños variados** (`[2048, 4096]` bytes canónicos,
> 70 atributos hoja fijos + 8 por ítem),
> no todos con 3.072. El JCS del orquestador y el de C3 tienen que ser el
> **mismo código**: si divergen, el tamaño no cuadra y la firma no verifica.

Swagger en `http://localhost:3001/docs`.

## El pipeline, hasta donde llega

```
documento del orquestador
  → C-02  validar forma y peso · party_id real · JCS · payload_hash
  → C-03  firmar Ed25519 (KMS Sign)
  → C-04  cifrar { payload, signature } (AES-256-GCM)
  → C-05  [ TX: expediente + fila de outbox ] · COMMIT
       ⋮   (el relay, en el mismo proceso, cada OUTBOX_POLL_MS)
  → C-06  reclamar · SendMessageBatch → SQS FIFO → SENT
```

### El outbox

**De esa tabla sale todo lo que llega a C4.** El relay no lee de ningún otro
sitio: lo que no quede ahí no se publica y no existe.

```sql
-- las dos escrituras van en LA MISMA transacción (regla 2)
BEGIN;
  INSERT INTO expediente ... ON CONFLICT (rpf_id) DO UPDATE ...  -- negocio
  INSERT INTO outbox (rpf_id, payload_hash, envelope, e0..e4)    -- PENDING
COMMIT;
-- nada se publica aquí (regla 3)
```

### Los tramos, medidos

803 eventos reales, con KMS, SQS y Postgres de verdad. Media en ms:

| tramo | ms | |
|---|---|---|
| `e1→e2` **firma KMS** | **83,0** | el cuello de botella de C3 |
| `e3→e4` commit | 3,3 | |
| `e4→e5` espera en outbox | 96,1 | ⚠ saturación |
| `e5→e6` publicar a SQS | 81,6 | |
| `e6→e7` **tiempo en cola** | **500,3** | ⚠ el tramo más caro de todos |
| `e7→e10` C4 completo | 28,4 | |
| **`e0→e10` extremo a extremo** | **800,3** | |

Conciliación por `payload_hash`: **803 en el outbox, 803 en el inbox, 0
perdidos, 0 descartes.**

Variables nuevas: `DATABASE_URL` y `SQS_QUEUE_URL` (**obligatorias**),
`C3_ESQUEMA` (`c3`), `C3_BD_POOL` (10), `OUTBOX_POLL_MS` (500),
`OUTBOX_BATCH_SIZE` (10), `OUTBOX_MAX_ATTEMPTS` (10),
`OUTBOX_BACKOFF_CAP_SEC` (300).

`POST /events` devuelve `aceptados` y `descartados` **por separado**:

```jsonc
{ "recibidos": 3, "aceptados": 1,
  "descartados": [
    { "event_id": "018f…", "indice": 1, "motivo": "importe_no_es_string", "campo": "totals.icms" },
    { "event_id": "018f…", "indice": 2, "motivo": "campo_faltante",      "campo": "document.access_key" }
  ] }
```

Un documento malo **no se lleva por delante a los buenos**. Y el conteo vuelve
al orquestador: si C3 se comiera los descartes en su log, la conciliación de P4
daría un falso negativo sin un solo error a la vista.

### El contrato de atributos

[`src/mapper/contrato.ts`](src/mapper/contrato.ts) declara los 16 bloques de
primer nivel y sus campos, y coincide campo por campo con lo que el generador
del orquestador emite hoy — así que **no rechaza tráfico real**. Verificado:
832 eventos de una corrida del orquestador, 0 descartes.

La regla que justifica el módulo entero: **`importe` es siempre `string`.** Un
importe que llegue como `1234.5` se canoniza, se firma y verifica
perfectamente; no lo atrapa nadie más abajo. Rompe el día que ese número pase
por otro formato de doble.

### Modo local

Sin `KMS_SIGN_KEY_ID` / `KMS_HMAC_KEY_ID` / `KMS_ENCRYPT_KEY_ID`, C3 firma con
una Ed25519 del proceso y cifra con una data key local. **Las tres o ninguna**
—a medias arranca y falla recién en C4—. Sirve para correr los tests sin
credenciales, y para nada más: C4 **no puede abrir** lo que sale de ahí, porque
la `edk` no viene de `GenerateDataKey` y la llave no está en su lista blanca.

```bash
npm test        # 155 tests; solo Postgres en 127.0.0.1:5433, sin AWS
```

## Lo que registra

Cada request trae la cabecera `x-prueba-id` del orquestador. C3 agrupa por
`(prueba, segundo)` y escribe **un objeto JSON válido por archivo** en
`c3/logs/<prueba>__<tenant>.json`, con el detalle por segundo, los minutos
agregados y el total — mismo formato que el informe del orquestador, para poder
ponerlos uno al lado del otro:

```jsonc
{
  "prueba": "abc16", "tenant": "tenant-01",
  "inicio": "…", "fin": "…", "duracion_s": 6.4, "cerrado_por": "silencio",
  "total": { … },
  "seconds": [ { "seg": 1, "at": "…", "metrics": {
      "request": { "init": 4, "completed": 4, "failed": 0,
                   "latency_p50_ms": 15.7, "latency_p99_ms": 17.9,
                   "latency_max_ms": 17.9, "latency_avg_ms": 15.7, "samples": 4 },
      "events":  { "init": 12, "completed": 12, "discarded": 0,
                   "bytes": 36837, "weight": "36.0 KB", "per_request": 3,
                   "event_ids_unicos": 12, "event_ids_duplicados": 0,
                   "steps": {
                     "canonical": { "init": 12, "completed": 12, "n": 12, "muestras": 12,
                                    "p50_ms": 0.063, "p95_ms": 0.504, "p99_ms": 0.504,
                                    "max_ms": 0.504, "avg_ms": 0.107, "suma_ms": 1.284 },
                     "sign": {…}, "encrypt": {…}, "outbox": {…}, "pipeline": {…},
                     "delay": {…}, "wait": {…}, "sqs": {…} } },
      "sqs":     { "batches": 0, "messages": 0, "ok": 0, "retry": 0, "failed": 0 }
  } } ],
  "minutes": [ … ]        // solo con más de 60 segundos
}
```

- **`init` no es `completed`.** Uno se cuenta al llegar la petición, el otro al
  contestar el 202; no caen en el mismo segundo y ese desfase **es** la
  latencia. Cuando el pipeline se atasca, `init` mantiene su ritmo y
  `completed` se hunde.
- **El mismo par baja a cada paso**, y ahí `init` cae en el segundo en que el
  tramo empezó y `completed` en el que terminó. Un `sign 45/0` seguido de un
  `sign 34/61` es KMS con 45 firmas en vuelo que devuelve al segundo siguiente.
  Que coincidan no es lo normal — significa que no quedó nada a medio hacer.
- **Ocho tramos**, con su unidad: `canonical`, `sign` y `encrypt` por
  **documento**; `outbox` (la transacción), `pipeline` (el loop entero) y
  `delay` (el retardo artificial de `C3_DELAY_MS`) por **petición**; `wait`
  (`e4→e5`, lo que la fila esperó en el outbox) por fila y solo en el primer
  intento; `sqs` (`e5→e6`) por **llamada** a `SendMessageBatch`, que lleva
  hasta 10 sobres.
- **La aritmética cuadra en el `total`, no en una fila**:
  `canonical + sign + encrypt + outbox = pipeline`, y `pipeline + delay` es casi
  toda la latencia. En una fila suelta no tiene por qué — los tramos de una
  petición que cruza la frontera del segundo caen repartidos, que es justo lo
  que `init` vs `completed` enseña. Sobre tráfico real el residuo del total es
  del 0,0002%.
- **Los percentiles de un segundo son exactos.** Solo `minutes` y `total` llevan
  `aproximado: true`. Y `suma_ms`/`avg_ms`/`max_ms` son exactos siempre, incluso
  cuando el techo de 500 muestras por segundo recorta los percentiles.
- **Duraciones con reloj monótono**, no restando las marcas `e0..e6`: esas son
  ISO y en local canonizar tarda 0,05 ms — saldría 0. Las marcas siguen en
  columnas del outbox, que es lo que permite conciliar con C4.
- **`pipeline` no es la latencia de la petición**: a la latencia le sobra el
  parseo, la respuesta y el retardo artificial de `C3_DELAY_MS`. Restarlos dice
  si 800 ms son de la firma o de una perilla de prueba.
- **Percentiles exactos dentro del segundo**, aproximados al agregar en minutos
  y total — y ahí lo declaran con `"aproximado": true`.
- **El peso sale del cuerpo crudo**, no de re-serializar los documentos: volver
  a pasarlos por `JSON.stringify` daría un número parecido pero no el que viajó
  por el cable, y el cable es lo que se está midiendo.
- **`event_ids_duplicados`** es la señal barata de que el pool del orquestador
  está reenviando plantillas tal cual — el fallo que SQS FIFO se tragaría en
  silencio. Se comparan contra **toda la prueba**, no contra el segundo.
- Se vuelca cada 10 s mientras hay tráfico, y al final tras 8 s de silencio o
  con SIGTERM. Temporal + `rename`: un fallo a media escritura no puede dejar un
  JSON truncado.
- `GET /status` da lo mismo **en vivo**, sin abrir archivos.

Variables: `TENANT_ID` (por defecto `puerto-<PORT>`) y `C3_LOGS_DIR` (por
defecto `c3/logs`). Detalle completo en
[docs/07-medicion.md](docs/07-medicion.md#el-log-de-tiempos--c3logspruebatenantjson).

## Flujo

```
POST { documentos: [...] }        ← ya hechos, del orquestador
  → Canonical Mapper (JCS RFC 8785)
  → Firma Ed25519 (KMS Sign)          ← el cuello de botella
  → Cifrado AES-256-GCM (data key cacheada por lote)
  → [ TRANSACCIÓN: estado de negocio + outbox ]
       ⋮  commit
  → relay (@Interval) → SendMessageBatch → SQS FIFO
```

## Tareas

| | Qué | Nota |
|---|---|---|
| `C-01` | Endpoint receptor `POST { documentos }` | **Encola y responde 202 ya.** Procesar inline agota el timeout HTTP y medirías el cliente, no la arquitectura. *Recibe y procesa; falta el encolado real.* |
| `C-02` | ✅ Canonical Mapper JCS | Valida contra [`src/mapper/contrato.ts`](src/mapper/contrato.ts), sustituye `party_id`, canoniza y saca el `payload_hash`. 95 vectores fijos. |
| `C-03` | ✅ Signer KMS Ed25519 | `ED25519_SHA_512` con `MessageType: RAW`. Cliente del SDK en **singleton**. |
| `C-04` | ✅ Cifrado + caché de data key | Una `GenerateDataKey` cada `C3_EVENTOS_POR_DATA_KEY` (100 por defecto), no por evento. |
| `C-05` | ✅ Outbox en la TX de negocio | Commit **antes** de publicar. Una transacción por lote, no por evento. |
| `C-06` | ✅ Relay | `finally` + drenado + backoff en base + circuit breaker en memoria. |
| `C-07` | ✅ Cierre ordenado en SIGTERM | Deja de tomar trabajo; lo no publicado sigue PENDING. |
| `C-08` | ✅ Health check real | `GET /health` consulta Postgres; `ok:false` si no contesta. |
| `C-09` | ✅ Marcas `e0..e6` | Las siete en columnas del outbox, **nunca dentro del payload**. |

## Variables de entorno — contrato de arranque

Acordadas antes de escribir código; desbloquean que `C` y `T` avancen en
paralelo.

```
TENANT_ID              identificador del tenant
DB_HOST                endpoint de su instancia RDS
DB_SECRET_ARN          credenciales en Secrets Manager
KMS_SIGN_KEY_ID        Ed25519 en C3
KMS_HMAC_KEY_ID        pseudonimización de tenant
KMS_ENCRYPT_KEY_ID     simétrica de C4 (solo GenerateDataKey)
SQS_QUEUE_URL          cola FIFO en C4
OUTBOX_POLL_MS=500
OUTBOX_BATCH_SIZE=10
OUTBOX_MAX_ATTEMPTS=10
OUTBOX_BACKOFF_CAP_SEC=300
```

## Las trampas de este track

- **`finally` en el relay.** Sin él una excepción deja `ocupado=true` para
  siempre: el relay se congela, el health check sigue en verde y los eventos
  se acumulan en silencio.
- **Drenado en el relay.** Sin él el techo son 10 msg por tick → 20/s por
  contenedor, sin importar cuánto aguante la base.
- **`attempts+1` al reclamar, no al fallar.** Si se hace al fallar, el
  `ROLLBACK` deshace el contador y el reintento es inmediato en vez de
  escalonado.
- **Importes y `access_key` son `string`.** JCS serializa números como
  doubles; `0.30000000000000004` rompe la firma. Aritmética en centavos
  enteros, formateo al final.
- **`Buffer.byteLength`, nunca `.length`.** Un acento son 2 bytes.
- **Nada de `Math.random()` en lo que se firma.** PRNG con semilla: una firma
  que no verifica tiene que ser reproducible. El `padding` sí puede ser
  aleatorio — no se firma su contenido, solo importa su largo.

El generador ya no es de este track: vive en
[../orquestador/src/generador/](../orquestador/src/generador/).
