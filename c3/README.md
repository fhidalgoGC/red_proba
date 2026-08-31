# c3 — Contenedor del cliente (track `C`)

NestJS. **Una sola imagen sirve a los 50 tenants**; todo lo que cambia son
variables de entorno (D-07).

El API y el relay del outbox viven en el **mismo proceso**. No son dos
contenedores ni dos services.

Doc de referencia: [../docs/03-contenedor-c3.md](../docs/03-contenedor-c3.md)

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
> Los eventos llegan con **tamaños variados** (`[1536, 3072]` bytes canónicos),
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
npm test        # 107 tests, sin AWS
```

## Lo que sí registra ya

Aunque no procese, **mide**. Cada request trae la cabecera `x-prueba-id` del
orquestador, y C3 agrupa por `(prueba, minuto)` y escribe una línea por minuto
en `c3/logs/<prueba>__<tenant>.json` — **un objeto JSON válido por archivo**,
con las ventanas en `minutos[]` y el acumulado en `totales`:

```jsonc
{
  "prueba": "xxt", "tenant": "tenant-01", "actualizado": "...",
  "totales": { "peticiones": 800, "eventos": 800, "bytes": 1839121,
               "bytes_medios_por_evento": 2299,
               "event_ids_unicos": 800, "event_ids_duplicados": 0 },
  "minutos": [ { "minuto": "2026-08-30T19:39:00.000Z", "completo": false,
                 "cerrado_por": "silencio",
                 "peticiones": 800, "eventos": 800, "bytes": 1839121,
                 "peticiones_por_s": 40.1, "eventos_por_s": 40.1, "mb_por_s": 0.088,
                 "event_ids_unicos": 800, "event_ids_duplicados": 0,
                 "ventana_activa_s": 19.9 } ]
}
```

- **El peso sale del cuerpo crudo**, no de re-serializar los documentos:
  volver a pasarlos por `JSON.stringify` daría un número parecido pero no el
  que viajó por el cable, y el cable es lo que se está midiendo.
- **`event_ids_duplicados`** es la señal barata de que el pool del orquestador
  está reenviando plantillas tal cual — el fallo que SQS FIFO se tragaría en
  silencio.
- El archivo se reescribe entero en cada ventana, con temporal + `rename`: un
  fallo a media escritura no puede dejar un JSON truncado.
- Los `event_id` se comparan contra **toda la prueba**, no solo contra el
  minuto: un duplicado que cruza la frontera del minuto sigue siendo un
  duplicado.
- Una ventana se cierra al terminar el minuto, tras 8 s de silencio, o al
  apagar el proceso; `completo` y `cerrado_por` dicen cuál fue.
- `GET /status` da el acumulado por prueba sin abrir archivos.

Variables: `TENANT_ID` (por defecto `puerto-<PORT>`) y `C3_LOGS_DIR` (por
defecto `c3/logs`).

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
DB_HOST                db-NN.poc.local
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
