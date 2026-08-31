# 03 — Contenedor del cliente (C3)

NestJS. Una sola imagen sirve a los 50 tenants; todo lo que cambia son
variables de entorno (ver contrato de arranque en `CLAUDE.md`).

Dentro del **mismo proceso** conviven el API y el relay del outbox. No son dos
contenedores ni dos servicios.

> **⚠ CAMBIO DE DISEÑO — C3 ya no genera.** El orquestador construye los
> documentos y se los manda hechos; C3 recibe `{ documentos: [...] }` y
> arranca en el Canonical Mapper. Ver
> [../orquestador/README.md](../orquestador/README.md).
>
> Consecuencias para este documento:
> - **C-01 pierde el generador.** Queda el endpoint que recibe y encola.
> - **`e0` cambia de significado**: ya no es «payload generado» sino «C3
>   recibió el documento y lo entrega al mapper». Esto ALINEA el código con
>   [07-medicion](07-medicion.md), que ya dejaba al generador fuera del
>   alcance de la medición.
> - **El JCS deja de ser exclusivo de C3.** El orquestador ajusta el tamaño
>   con JCS y C3 firma con JCS: si divergen, el tamaño no cuadra y la firma no
>   verifica. Tiene que ser código compartido, no dos implementaciones.
> - **`party_id` sigue siendo de C3.** El orquestador manda un placeholder
>   de largo fijo (`hmac:` + 64 hex, 69 caracteres) y C3 lo sustituye por el
>   HMAC-SHA256 real de `KMS_HMAC_KEY_ID`, **completo, sin truncar**. Mismo
>   largo, así que el tamaño canónico no se mueve y la llave de
>   pseudonimización nunca sale del dominio del participante.
> - **Los eventos ya no pesan todos 3.072 bytes**: llegan con tamaños
>   sorteados en un rango. Ver [02-payload](02-payload.md).

## Flujo

```
POST { documentos: [...] }        ← ya hechos, del orquestador
   → Canonical Mapper (JCS RFC 8785)
   → Firma Ed25519 (KMS Sign)            ← cuello de botella
   → Cifrado AES-256-GCM (data key)
   → [ TRANSACCIÓN: estado + outbox ]
        ⋮  (relay, proceso aparte)
   → SendMessageBatch → SQS FIFO
```

## Tareas

### C-01 · Endpoint receptor

Recibe `{ lote_id, tenant_id, documentos: [...] }`, **encola el trabajo y
responde 202 de inmediato** con el id de lote. No procesa dentro del handler.

> Con lotes grandes, canonizar + firmar N eventos dentro del request agota el
> timeout HTTP. Con firmas de KMS de por medio, unos pocos miles de eventos
> pasan del minuto. Si no encolas, el techo que mides es el del cliente HTTP,
> no el de tu arquitectura.

**Estado**: recibe, valida, canoniza, firma y cifra. **No escribe outbox ni
publica a SQS**, así que el sobre se construye y se tira: hoy nada llega a C4.
El encolado real (responder 202 y procesar fuera del handler) sigue pendiente
— hoy procesa dentro del request.

`POST /events` es la **única** entrada. El camino de generación
(`POST /events/generar { n }`) se eliminó: la generación vive en el
orquestador, que manda los documentos ya hechos.

### C-02 · Canonical Mapper ✅

JCS, RFC 8785. **Batería de tests con vectores fijos antes que cualquier otra
cosa** — es la pieza de la que dependen firma y verificación.

Hecho en `c3/src/mapper/`. Tres pasos, en este orden: validar la forma contra
`contrato.ts` y el peso contra el rango → sustituir `party_id` por el HMAC
real → canonizar y sacar el `payload_hash`.

El orden no es negociable: `party_id` es un campo del payload, así que entra
en lo que se firma. Sustituirlo después de canonizar dejaría la firma cubriendo
el placeholder.

`contrato.ts` declara todos los atributos exigidos y coincide con lo que el
generador emite hoy, así que no rechaza tráfico real (verificado: 832 eventos
de una corrida, 0 descartes). 95 vectores fijos, incluido uno por cada campo
faltante, generado sobre el propio contrato.

### C-03 · Signer ✅

KMS `Sign` con Ed25519. Cliente del SDK en **singleton**: crear uno por
petición añade latencia de handshake a cada evento y distorsiona la medición.

`SigningAlgorithm: ED25519_SHA_512` con `MessageType: RAW` — KMS hace el
SHA-512 por dentro. La variante `ED25519_PH_SHA_512` pide `DIGEST` y produce
firmas que la verificación Ed25519 pura de C4 rechazaría.

### C-04 · Cifrado con caché de data key ✅

AES-256-GCM sobre `{ payload, signature }`. La data key se obtiene con
`GenerateDataKey` sobre la llave simétrica de C4.

**Con caché**: una llamada por lote, no por evento. `GenerateDataKey` es
simétrica ($0.03/10k y límite de throughput mucho más alto que la firma), pero
llamarla por evento duplicaría innecesariamente el tráfico a KMS.

Hecho: `C3_EVENTOS_POR_DATA_KEY` (100 por defecto). La renovación se comparte
entre peticiones concurrentes — sin eso, N requests que llegan con la data key
agotada disparan N `GenerateDataKey` a la vez, justo bajo la ráfaga.

### C-05 · Escritura del outbox en la transacción de negocio

```sql
BEGIN;
  UPDATE  -- estado del negocio, thread por rpf_id
  INSERT INTO outbox (...)  -- sobre cifrado, status='PENDING'
COMMIT;
-- nada se publica aquí
```

### C-06 · Relay

Ver [detalle abajo](#el-relay).

### C-07 · Cierre ordenado en SIGTERM

Fargate da 30 segundos. Terminar la petición en vuelo, dejar de tomar trabajo
nuevo, cerrar el pool. Sin esto, cada despliegue pierde eventos.

### C-08 · Health check real

`GET /health` que verifique de verdad la conexión a la base. Si responde 200
siempre, no te enteras de que una base murió.

### C-09 · Marcas de tiempo e0..e6

Columnas de la fila del outbox, **nunca dentro del payload**. Ver
[07-medicion](07-medicion.md).

---

## El relay

### Forma

`@Interval` de `@nestjs/schedule` con **guardia** y **drenado**. No es un
scheduler externo: el timer vive en el mismo proceso.

```ts
@Injectable()
export class OutboxRelay {
  private ocupado = false;

  @Interval(500)
  async tick() {
    if (this.ocupado) return;          // ya hay uno trabajando
    this.ocupado = true;
    try {
      let n: number;
      do { n = await this.publicarLote(); } while (n > 0);   // drenado
    } catch (e) {
      this.logger.error('fallo en el relay', e);
    } finally {
      this.ocupado = false;            // pase lo que pase
    }
  }
}
```

**El `finally` no es opcional.** Sin él, una excepción deja `ocupado` en `true`
para siempre: el relay se congela, el health check sigue en verde y los eventos
se acumulan en silencio.

**El drenado no es opcional.** Sin él el techo es 10 mensajes por tick — 20/s
por contenedor — sin importar cuánto aguante la base.

### Reclamo del lote

El backoff **vive en la base**, no en memoria: una fila puede sobrevivir a
varios reinicios del contenedor. El incremento ocurre **al reclamar**, no al
fallar — si se hiciera al fallar, el `ROLLBACK` deshace el contador y el
reintento sería inmediato en vez de escalonado.

```sql
WITH lote AS (
  SELECT id FROM outbox
   WHERE status = 'PENDING'
     AND next_attempt <= now()
   ORDER BY created_at
   LIMIT 10
     FOR UPDATE SKIP LOCKED
)
UPDATE outbox o
   SET attempts     = o.attempts + 1,
       next_attempt = now() + (interval '1 second'
                     * least(power(2, o.attempts), 300)   -- techo 5 min
                     * (0.5 + random()))                  -- jitter
  FROM lote
 WHERE o.id = lote.id
 RETURNING o.id, o.rpf_id, o.payload_hash, o.envelope, o.attempts;
```

Este `UPDATE` **hace commit antes de publicar**. A partir de ahí:

| Caso | Qué pasa |
|---|---|
| Publica bien | Segunda transacción marca `SENT`. |
| Falla la publicación | Nada. La fila ya tiene `attempts+1` y `next_attempt` futuro: se reintenta sola. |
| El contenedor muere a media publicación | Idéntico. Se recupera solo. |

Los tres casos caen en el mismo camino: no hace falta transacción autónoma ni
lógica de compensación.

**`SKIP LOCKED`** evita que dos workers tomen las mismas filas.
**El jitter** evita el thundering herd: cuando SQS devuelve throttling los 50
contenedores fallan casi a la vez, y sin `random()` reintentarían todos en el
mismo instante.

### Crecimiento del backoff

| intento | espera base | con jitter |
|---|---|---|
| 1 | 1 s | 0.5 – 1.5 s |
| 3 | 4 s | 2 – 6 s |
| 5 | 16 s | 8 – 24 s |
| 8 | 128 s | 64 – 192 s |
| 9+ | 300 s (techo) | 150 – 450 s |

`OUTBOX_MAX_ATTEMPTS=10` → una fila agota sus intentos en unos 14 minutos.

### Estados

```
          commit
             │
             ▼
        ┌─────────┐   SQS confirma    ┌────────┐
        │ PENDING │ ────────────────► │  SENT  │
        └────┬────┘                   └────────┘
             │  ▲
   error ────┘  │ attempts += 1 · backoff
                │
        attempts > máx
             │
             ▼
        ┌─────────┐      ┌──────────────┐
        │ FAILED  │ ───► │ alarma / DLQ │
        └─────────┘      └──────────────┘
```

`FAILED` **no es opcional**: sin él una fila que falla se reintenta para siempre
y el relay se atasca sobre el mismo lote mientras la cola crece por detrás.

### Circuit breaker (en memoria, este sí)

| | Dónde | Alcance | Protege de |
|---|---|---|---|
| `attempts` / `next_attempt` | base de datos | una fila | que un evento problemático se reintente en bucle |
| circuit breaker | memoria | toda la dependencia | que sigas martillando un SQS caído |

```ts
private pausaHasta = 0;
private fallosSeguidos = 0;

// tras fallar el lote completo
this.fallosSeguidos++;
this.pausaHasta = Date.now() + Math.min(2 ** this.fallosSeguidos * 250, 30_000);

// tras un lote exitoso
this.fallosSeguidos = 0;
this.pausaHasta = 0;
```

Sin esto, una caída de SQS de 15 minutos manda **todas** las filas a `FAILED`
por un problema que no era de ellas.

**La regla**: si el problema es de la fila, va a la base; si es de la
dependencia, va en memoria.

### Purgado — este sí es cron de verdad

```ts
@Cron(CronExpression.EVERY_HOUR)
async purgar() {
  await this.db.query(`
    DELETE FROM outbox
     WHERE status='SENT' AND sent_at < now() - interval '2 hours'`);
  await this.db.query(`
    UPDATE outbox SET status='FAILED'
     WHERE status='PENDING' AND attempts >= $1`, [MAX_ATTEMPTS]);
}
```

No debe correr en el mismo bucle que publica: borrar mientras publicas mete
contención de vacuum bajo carga.

## Esquema

```sql
CREATE TABLE outbox (
  id              BIGSERIAL PRIMARY KEY,
  rpf_id          UUID        NOT NULL,      -- MessageGroupId
  payload_hash    TEXT        NOT NULL,      -- sha256 del canónico EN CLARO (paso ②)
  envelope        JSONB       NOT NULL,      -- el sobre cifrado completo
  status          TEXT        NOT NULL DEFAULT 'PENDING',
  attempts        INT         NOT NULL DEFAULT 0,
  next_attempt    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at         TIMESTAMPTZ,
  last_error_code TEXT,                      -- sin esto FAILED no es accionable
  last_error      TEXT,
  -- marcas de medición, ver 07-medicion.md
  e0_listo TIMESTAMPTZ, e1_canonizado TIMESTAMPTZ, e2_firmado  TIMESTAMPTZ,
  e3_cifrado TIMESTAMPTZ, e4_commit   TIMESTAMPTZ, e5_reclamado TIMESTAMPTZ,
  e6_publicado TIMESTAMPTZ
);

-- Índice PARCIAL: la tabla crece con lo enviado, el índice solo
-- contiene lo pendiente y se mantiene pequeño.
CREATE INDEX outbox_pending_idx
  ON outbox (next_attempt)
  WHERE status = 'PENDING';
```

## Clasificación de errores

Reintentar no sirve para todos. Los permanentes van directo a `FAILED`:

```ts
const PERMANENTES = new Set([
  'InvalidParameterValue',    // > 256 KB, MessageGroupId inválido
  'InvalidMessageContents',   // caracteres no aceptados por SQS
  'AccessDenied',             // falta resource policy o permiso KMS
  'QueueDoesNotExist',
  'UnsupportedOperation',
]);
```

**Los dos que vas a pegar de verdad en esta PoC**: `AccessDenied` cross-account
(resource policy de la cola o `kms:GenerateDataKey`) y errores de configuración.
El tamaño de mensaje no es riesgo: hay 60× de margen.

Reintentar sí sirve para: `ThrottlingException`, timeouts de red, 5xx de SQS,
rotación de credenciales y muerte del contenedor a media publicación.
