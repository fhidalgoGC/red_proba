/**
 * Esquema del Postgres de cada tenant. Se aplica al arrancar, es idempotente.
 *
 * Migraciones en el arranque y no un runner aparte: la PoC levanta y baja
 * infraestructura entera con un comando, y un paso manual entre el `apply` y
 * la corrida es justo el tipo de conocimiento que vive en la cabeza de alguien
 * y se pierde. Son 50 bases; un paso manual por tenant no es una opcion.
 */
export function esquemaSql(esquema: string): string {
  const e = `"${esquema.replace(/"/g, '')}"`;
  return `
CREATE SCHEMA IF NOT EXISTS ${e};

-- ── ESTADO DE NEGOCIO · el expediente ──────────────────────────────────
--
-- El "thread" por rpf_id de C-05. Es deliberadamente pequeño: la PoC no
-- simula un ERP, simula que EXISTE una escritura de negocio con la que el
-- outbox tiene que compartir transaccion. Sin una segunda tabla, la regla 2
-- no se puede ni demostrar ni romper, y seria una regla decorativa.
CREATE TABLE IF NOT EXISTS ${e}.expediente (
  rpf_id         UUID PRIMARY KEY,
  eventos        INT         NOT NULL DEFAULT 0,
  sequence_min   INT,
  sequence_max   INT,
  primer_evento  TIMESTAMPTZ,
  ultimo_evento  TIMESTAMPTZ,
  actualizado    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── C-05 · OUTBOX. De aqui sale TODO lo que llega a C4 ─────────────────
--
-- Es la unica fuente del relay: lo que no quede en esta tabla no se publica,
-- y por lo tanto no existe para C4. Por eso se escribe en la MISMA
-- transaccion que el expediente (regla 2) — si fueran dos escrituras
-- separadas no tendrias un outbox, tendrias dos tablas que se
-- desincronizan en el primer fallo entre una y otra.
CREATE TABLE IF NOT EXISTS ${e}.outbox (
  id              BIGSERIAL PRIMARY KEY,

  -- MessageGroupId de SQS: ordena los eventos de un mismo expediente.
  rpf_id          UUID        NOT NULL,
  -- MessageDeduplicationId, y la llave con la que se concilia contra el
  -- inbox de C4. Es el sha256 del canonico EN CLARO (paso ②).
  payload_hash    TEXT        NOT NULL,

  -- El sobre cifrado completo, tal como va a viajar. JSONB y no TEXT para
  -- poder inspeccionar key_id o alg en una consulta sin parsear a mano
  -- cuando algo no cuadre; el contenido real sigue siendo opaco.
  envelope        JSONB       NOT NULL,

  status          TEXT        NOT NULL DEFAULT 'PENDING',
  attempts        INT         NOT NULL DEFAULT 0,
  next_attempt    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at         TIMESTAMPTZ,

  -- Sin el codigo, un FAILED no es accionable: no distingues "AccessDenied
  -- cross-account" de "la red se cayo tres veces".
  last_error_code TEXT,
  last_error      TEXT,

  -- ── C-09 · la corrida ──
  -- El x-prueba-id de la peticion que escribio la fila. Es METADATO de
  -- medicion, igual que las marcas de abajo, y por la misma razon vive en una
  -- columna y no dentro del payload (regla 8).
  --
  -- Sin ella el relay no sabria a que prueba pertenece lo que publica: corre en
  -- su propio timer, fuera de cualquier request, asi que los tramos e4->e5 y
  -- e5->e6 acabarian todos en 'sin-id' mientras el resto del informe lleva el
  -- id de verdad.
  prueba          TEXT,

  -- ── C-09 · marcas de medicion ──
  -- En COLUMNAS y nunca dentro del payload (regla 8): el payload va firmado,
  -- y meterle metadatos de medicion cambiaria lo que se firma.
  e0_listo        TIMESTAMPTZ,   -- C3 recibio el documento y lo dio al mapper
  e1_canonizado   TIMESTAMPTZ,
  e2_firmado      TIMESTAMPTZ,   -- KMS Sign devolvio
  e3_cifrado      TIMESTAMPTZ,
  e4_commit       TIMESTAMPTZ,   -- esta transaccion
  e5_reclamado    TIMESTAMPTZ,   -- el relay tomo la fila        (C-06)
  e6_publicado    TIMESTAMPTZ,   -- SQS confirmo                 (C-06)

  CONSTRAINT outbox_status_valido CHECK (status IN ('PENDING', 'SENT', 'FAILED'))
);

-- Indice PARCIAL: la tabla crece con todo lo enviado, pero el indice solo
-- contiene lo PENDIENTE y se mantiene pequeño. El relay pregunta siempre por
-- lo mismo -status='PENDING' AND next_attempt <= now()- y ese es exactamente
-- el conjunto que este indice cubre.
CREATE INDEX IF NOT EXISTS outbox_pendientes
  ON ${e}.outbox (next_attempt)
  WHERE status = 'PENDING';

-- Para conciliar outbox contra el inbox de C4, que es como se responde P4.
CREATE INDEX IF NOT EXISTS outbox_payload_hash ON ${e}.outbox (payload_hash);

-- Para el purgado horario de C-06: borra SENT viejos sin recorrer la tabla.
CREATE INDEX IF NOT EXISTS outbox_enviados
  ON ${e}.outbox (sent_at)
  WHERE status = 'SENT';

-- ── Columnas añadidas despues ──────────────────────────────────────────
--
-- CREATE TABLE IF NOT EXISTS no toca una tabla que ya existe, asi que una
-- base creada antes de C-09 se quedaria sin la columna 'prueba' y el INSERT
-- del outbox fallaria con "column does not exist" en el primer evento de la
-- corrida. El ALTER es idempotente y cuesta un catalogo: se ejecuta siempre.
ALTER TABLE ${e}.outbox ADD COLUMN IF NOT EXISTS prueba TEXT;
`;
}
