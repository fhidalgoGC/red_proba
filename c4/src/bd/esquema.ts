/**
 * Esquema del Postgres de C4. Se aplica al arrancar, es idempotente.
 *
 * Migraciones en el arranque y no un runner aparte: la PoC levanta y baja
 * infraestructura entera con un comando (preferencia del proyecto), y un paso
 * manual entre `apply` y la corrida es justo el tipo de conocimiento que vive
 * en la cabeza de alguien y se pierde.
 */
export function esquemaSql(esquema: string): string {
  const e = `"${esquema.replace(/"/g, '')}"`;
  return `
CREATE SCHEMA IF NOT EXISTS ${e};

-- ── G-03 · INBOX. La tabla de la que depende P4 ────────────────────────
--
-- payload_hash es PRIMARY KEY y ese detalle ES la idempotencia: la entrega es
-- al-menos-una-vez y los duplicados son parte del contrato (regla 4). Sin
-- esta restriccion cada reintento del relay duplicaria un asiento fiscal.
CREATE TABLE IF NOT EXISTS ${e}.inbox (
  payload_hash        TEXT PRIMARY KEY,
  rpf_id          UUID        NOT NULL,
  sequence        INT         NOT NULL,
  event_id        UUID,
  event_type      TEXT,
  schema_version  TEXT,
  party_id      TEXT,
  key_id          TEXT,
  occurred_at     TIMESTAMPTZ,

  message_id      TEXT,
  recepciones     INT         NOT NULL DEFAULT 1,
  duplicados      INT         NOT NULL DEFAULT 0,
  bytes_sobre     INT,
  bytes_canonicos INT,

  -- Marcas e7..e10 (07-medicion). Nunca dentro del payload: el payload va
  -- firmado y meterle metadatos de medicion cambiaria lo que se firmo.
  sqs_enviado     TIMESTAMPTZ,   -- SentTimestamp de SQS, aproximacion de e6
  e7_recibido     TIMESTAMPTZ,
  -- ⚠ e7b no esta en 07-medicion y hace falta igual.
  --
  -- e7 es "llego el lote": los hasta 10 mensajes de un ReceiveMessage llegan
  -- en el mismo instante, pero se procesan en serie. Sin e7b, el tramo e7→e8
  -- del ultimo mensaje del lote incluye el procesamiento de los nueve
  -- anteriores, y el numero diria "descifrar tarda 400 ms" cuando descifrar
  -- tarda 3 y lo que hubo fue espera. e7→e7b es esa espera; e7b→e8 es el
  -- descifrado de verdad.
  e7b_tomado      TIMESTAMPTZ,
  e8_descifrado   TIMESTAMPTZ,
  e9_verificado   TIMESTAMPTZ,
  e10_persistido  TIMESTAMPTZ    -- se estampa DESPUES del COMMIT
);

CREATE INDEX IF NOT EXISTS inbox_rpf_seq ON ${e}.inbox (rpf_id, sequence);
CREATE INDEX IF NOT EXISTS inbox_e7      ON ${e}.inbox (e7_recibido);

-- ── G-04 · Los cinco schemas ───────────────────────────────────────────

-- 1. Journal: append-only. Es el libro. No se actualiza ni se borra.
CREATE TABLE IF NOT EXISTS ${e}.journal (
  id           BIGSERIAL PRIMARY KEY,
  payload_hash     TEXT        NOT NULL REFERENCES ${e}.inbox (payload_hash),
  rpf_id       UUID        NOT NULL,
  sequence     INT         NOT NULL,
  event_id     UUID,
  event_type   TEXT,
  occurred_at  TIMESTAMPTZ,
  payload      JSONB,
  registrado   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS journal_rpf ON ${e}.journal (rpf_id, sequence);

-- 2. Case Header: el estado consultable de cada expediente.
CREATE TABLE IF NOT EXISTS ${e}.case_header (
  rpf_id          UUID PRIMARY KEY,
  party_id      TEXT,
  primer_evento   TIMESTAMPTZ,
  ultimo_evento   TIMESTAMPTZ,
  eventos         INT  NOT NULL DEFAULT 0,
  sequence_min    INT,
  sequence_max    INT,
  ultimo_tipo     TEXT,
  access_key      TEXT,
  total_products  TEXT,
  actualizado     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. Shared Map: quien negocia con quien, sin saber quien es ninguno.
CREATE TABLE IF NOT EXISTS ${e}.shared_map (
  party_id          TEXT NOT NULL,
  counterparty_cnpj   TEXT NOT NULL,
  uf                  TEXT,
  expedientes         INT  NOT NULL DEFAULT 0,
  eventos             INT  NOT NULL DEFAULT 0,
  visto_primero       TIMESTAMPTZ NOT NULL DEFAULT now(),
  visto_ultimo        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (party_id, counterparty_cnpj)
);

-- 4. Policy Registry: que versiones de schema y que tipos estan en curso.
CREATE TABLE IF NOT EXISTS ${e}.policy_registry (
  event_type      TEXT NOT NULL,
  schema_version  TEXT NOT NULL,
  eventos         INT  NOT NULL DEFAULT 0,
  visto_primero   TIMESTAMPTZ NOT NULL DEFAULT now(),
  visto_ultimo    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (event_type, schema_version)
);

-- 5. Key Registry: que llave cubrio que eventos.
--
-- No es decorativo. Es la tabla que permite contestar "de todo lo que hay en
-- el libro, ¿que quedo cubierto por que llave?" el dia que una se rote o se
-- comprometa. Sin esto, una rotacion obliga a re-verificar todo el journal.
CREATE TABLE IF NOT EXISTS ${e}.key_registry (
  key_id          TEXT PRIMARY KEY,
  sig_alg         TEXT,
  aceptada        BOOLEAN NOT NULL DEFAULT true,
  eventos         INT  NOT NULL DEFAULT 0,
  visto_primero   TIMESTAMPTZ NOT NULL DEFAULT now(),
  visto_ultimo    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── G-07 · Evidencia de lo descartado ──────────────────────────────────
--
-- Un evento que va a la DLQ tiene que dejar rastro AQUI, no solo en la cola.
-- Si no, desaparece del conteo y P4 muestra un faltante indistinguible de un
-- mensaje perdido: el caso mas grave -posible inyeccion- se disfrazaria del
-- mas aburrido.
CREATE TABLE IF NOT EXISTS ${e}.descartes (
  id            BIGSERIAL PRIMARY KEY,
  payload_hash      TEXT,
  rpf_id        TEXT,
  message_id    TEXT,
  motivo        TEXT NOT NULL,
  alarma        BOOLEAN NOT NULL DEFAULT false,
  detalle       TEXT,
  bytes_sobre   INT,
  recepciones   INT,
  a_la_dlq      BOOLEAN NOT NULL DEFAULT false,
  e7_recibido   TIMESTAMPTZ,
  registrado    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS descartes_motivo ON ${e}.descartes (motivo);
`;
}
