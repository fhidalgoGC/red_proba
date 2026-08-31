# 03 · La base

⚠ **Es una base PROPIA, no un esquema dentro de la de C3.** C3 y C4 son
dominios sin ruta de red entre ellos (D-03): el único canal es la cola.
Compartir base los volvería consultables entre sí, y una conciliación por
`JOIN` pasaría en local siendo imposible en producción. En AWS son dos RDS
separados; en local, `rpf_c4` frente a `rpf_c3_tenant01` y `rpf_c3_tenant02`.

Siete tablas en el esquema `c4` (configurable con `C4_ESQUEMA`). El esquema se
aplica **al arrancar** y es idempotente: la PoC levanta y baja infraestructura
con un comando, y un paso manual entre el `apply` y la corrida es justo el tipo
de conocimiento que vive en la cabeza de alguien y se pierde.

| Tabla | Qué es |
|---|---|
| `inbox` | La clave de la idempotencia y de P4 |
| `journal` | Append-only. El libro |
| `case_header` | El expediente consultable |
| `shared_map` | Con quién opera cada participante |
| `policy_registry` | Qué tipos y versiones están en curso |
| `key_registry` | Qué llave cubrió qué eventos |
| `descartes` | La evidencia de G-07 |

Las cinco del medio son los **cinco schemas** de `G-04`.

---

## `inbox` — de la que depende P4

```sql
CREATE TABLE inbox (
  payload_hash        TEXT PRIMARY KEY,     -- ⚠ esto ES la idempotencia
  rpf_id          UUID NOT NULL,
  sequence        INT  NOT NULL,
  event_id        UUID,
  event_type      TEXT,
  schema_version  TEXT,
  party_id      TEXT,
  key_id          TEXT,
  occurred_at     TIMESTAMPTZ,

  message_id      TEXT,
  recepciones     INT NOT NULL DEFAULT 1,
  duplicados      INT NOT NULL DEFAULT 0,
  bytes_sobre     INT,
  bytes_canonicos INT,
  prueba          TEXT,          -- id de corrida, del MessageAttribute

  sqs_enviado     TIMESTAMPTZ,   -- SentTimestamp, aproximación de e6
  e7_recibido     TIMESTAMPTZ,
  e7b_tomado      TIMESTAMPTZ,
  e8_descifrado   TIMESTAMPTZ,
  e9_verificado   TIMESTAMPTZ,
  e10_persistido  TIMESTAMPTZ    -- DESPUÉS del COMMIT
);
```

`prueba` es **metadato de la corrida, no del evento**: por eso es columna y no va
dentro del payload, que va firmado (regla 8). Llega en el `MessageAttribute`
`prueba` del mensaje, que escribe el relay de C3 copiando el `x-prueba-id` del
orquestador. Es lo que hace exacto el corte de `npm run informe -- --prueba <id>`
— una ventana temporal (`--desde <ISO>`) no distingue dos corridas que se solapan
en la cola ni sobrevive a que alguien se equivoque de hora.

`payload_hash` como `PRIMARY KEY` no es una elección de modelado: **es la
idempotencia entera**. La escritura es:

```sql
INSERT INTO inbox (...) VALUES (...)
ON CONFLICT (payload_hash) DO NOTHING
RETURNING payload_hash;      -- vacío = era duplicado
```

Si ya estaba, se incrementan `duplicados` y `recepciones` y **no se proyecta
nada**. Contarlos importa: es la prueba de que la entrega al-menos-una-vez está
ocurriendo de verdad y de que el inbox la está absorbiendo. Sin esto, cada
reintento del relay duplicaría un asiento fiscal en un libro append-only — y
eso no se corrige después sin romper el «append-only».

---

## Inbox y proyección van en la MISMA transacción

Por la misma razón por la que el outbox de C3 va en la transacción de negocio
(regla 2): si se separan, un fallo entre las dos deja un `payload_hash` marcado
como visto y un journal sin el asiento. **El reintento lo vería como duplicado
y no lo escribiría nunca.** El evento quedaría contado en P4 y ausente del
libro.

```sql
BEGIN;
  INSERT INTO inbox ... ON CONFLICT DO NOTHING RETURNING payload_hash;
  -- si insertó:
  INSERT INTO journal ...;          -- 1
  INSERT INTO case_header ... ON CONFLICT DO UPDATE ...;   -- 2
  INSERT INTO shared_map ... ON CONFLICT DO UPDATE ...;    -- 3
  INSERT INTO policy_registry ... ON CONFLICT DO UPDATE ...;  -- 4
  INSERT INTO key_registry ... ON CONFLICT DO UPDATE ...;     -- 5
COMMIT;
-- y AHORA se estampa e10
```

---

## Los cinco schemas

### 1 · `journal` — append-only

Un `INSERT`, nunca un `UPDATE`. Es el libro. Guarda el payload como `JSONB`
(apagable con `C4_GUARDAR_PAYLOAD=false`).

> El payload queda **en claro** aquí. Es lo que convierte el journal en algo
> consultable en vez de una lista de hashes — y es exactamente el dato que en
> producción decide quién puede leer esta base. Que sea una decisión
> consciente, no un descuido.

### 2 · `case_header` — el expediente

Una fila por `rpf_id`: primer y último evento, rango de `sequence`, último
tipo, `access_key`, totales.

Usa `LEAST`/`GREATEST` y no «el último que llegó». FIFO garantiza orden por
grupo, pero **un mensaje que reaparece tras un visibility timeout puede volver
detrás de otro**. Con `GREATEST`, reprocesar es inofensivo; con «el último
gana», `sequence_max` podría retroceder.

### 3 · `shared_map` — quién opera con quién

`(party_id, counterparty_cnpj)`, con `uf`, `expedientes` y `eventos`.
`party_id` es el pseudónimo HMAC-SHA256 que escribió C3: **C4 agrupa por
participante sin saber quién es**.

`expedientes` solo se incrementa en el primer evento del expediente
(`sequence <= 1`); contarlo en cada uno lo convertiría en un duplicado de
`eventos` y dejaría de significar nada.

### 4 · `policy_registry` — qué está en curso

`(event_type, schema_version)` con conteo y primera/última vez vista. Es lo que
responde «¿qué versiones de schema hay circulando ahora mismo?».

### 5 · `key_registry` — qué llave cubrió qué

No es decorativo. Es la tabla que permite contestar **«de todo lo que hay en el
libro, ¿qué quedó cubierto por qué llave?»** el día que una se rote o se
comprometa. Sin ella, una rotación obliga a re-verificar el journal entero.

---

## `descartes` — por qué P4 cierra

```sql
CREATE TABLE descartes (
  id BIGSERIAL PRIMARY KEY,
  payload_hash TEXT, rpf_id TEXT, message_id TEXT,
  motivo TEXT NOT NULL,
  alarma BOOLEAN NOT NULL DEFAULT false,
  detalle TEXT,
  bytes_sobre INT, recepciones INT,
  a_la_dlq BOOLEAN NOT NULL DEFAULT false,
  e7_recibido TIMESTAMPTZ,
  registrado TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Un evento que va a la DLQ **tiene que dejar rastro aquí, no solo en la cola**.
Si no, desaparece del conteo y P4 muestra un faltante indistinguible de un
mensaje perdido: **el caso más grave —posible inyección— se disfrazaría del más
aburrido.**

Y la profundidad de la DLQ no sirve para contar: al republicar se conserva el
`payload_hash` original, así que el mismo veneno repetido se descarta en silencio
durante cinco minutos. Es lo deseable —no se duplica la evidencia— pero implica
que el conteo vive **aquí**. Con eso, la ecuación cierra:

```
ofrecidos = persistidos + duplicados + descartes + en_vuelo
```

---

## Las consultas

### Conciliación (P4)

```sql
SELECT
  (SELECT COUNT(*) FROM c4.inbox)                              AS inbox,
  (SELECT COALESCE(SUM(duplicados),0) FROM c4.inbox)           AS duplicados,
  (SELECT COUNT(*) FROM c4.inbox WHERE e10_persistido IS NULL) AS sin_e10,
  (SELECT COUNT(*) FROM c4.journal)                            AS journal,
  (SELECT COUNT(*) FROM c4.case_header)                        AS expedientes,
  (SELECT COUNT(*) FROM c4.descartes)                          AS descartes,
  (SELECT COUNT(*) FROM c4.descartes WHERE alarma)             AS con_alarma;
```

### Huecos de `sequence` (G-05)

```sql
SELECT rpf_id, MIN(sequence), MAX(sequence), COUNT(*)
  FROM c4.inbox
 GROUP BY rpf_id
HAVING MAX(sequence) - MIN(sequence) + 1 <> COUNT(DISTINCT sequence);
```

Con FIFO no debería salir ninguno, **y por eso vale medirlo**: un solo hueco
invalida la afirmación de orden, y eso es un hallazgo mucho más grave que
cualquier latencia. La implementación devuelve además qué números faltan.

Ojo con el falso positivo: si un veneno se quedara bloqueando la cabeza de su
grupo, esta consulta reportaría un hueco que no lo es. Ésa es la razón por la
que el veneno sale de la cola en el acto — ver [06 · Reglas](06-reglas.md).

### Motivos de descarte

```sql
SELECT motivo, COUNT(*) FROM c4.descartes GROUP BY motivo ORDER BY 2 DESC;
```

Que el total cuadre no basta. Dos venenos rechazados por el motivo equivocado
darían el mismo total y esconderían que una de las dos guardas no funciona.
