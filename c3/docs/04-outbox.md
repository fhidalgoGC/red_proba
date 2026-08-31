# 04 · El outbox

> **De esta tabla sale TODO lo que llega a C4.** El relay no lee de ningún otro
> sitio: lo que no quede aquí no se publica y, por lo tanto, no existe para C4.

---

## Base propia por tenant

```
rpf_c3_tenant01   esquema c3    ← tenant-01
rpf_c3_tenant02   esquema c3    ← tenant-02
rpf_c4            esquema c4    ← C4
```

Mismo nombre de esquema en todos los tenants a propósito: es **una sola imagen**
para los 50, y lo único que cambia es `DATABASE_URL`. En AWS es un RDS por
tenant; el código no se entera.

**Y nunca la base de C4.** C3 y C4 son dominios sin ruta de red entre ellos
(D-03). Con base compartida se puede escribir esto:

```sql
FROM c3.outbox o JOIN c4.inbox i USING (payload_hash)   -- imposible en producción
```

y la prueba daría verde **por una razón que no existe fuera del portátil**. La
conciliación se hace exportando de cada base y cruzando fuera — ver
[07 · Medición](07-medicion.md).

---

## Las dos tablas

```sql
CREATE TABLE expediente (          -- el estado de negocio, "thread" por rpf_id
  rpf_id         UUID PRIMARY KEY,
  eventos        INT NOT NULL DEFAULT 0,
  sequence_min   INT,  sequence_max INT,
  primer_evento  TIMESTAMPTZ, ultimo_evento TIMESTAMPTZ,
  actualizado    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE outbox (
  id              BIGSERIAL PRIMARY KEY,
  rpf_id          UUID  NOT NULL,     -- MessageGroupId
  payload_hash    TEXT  NOT NULL,     -- MessageDeduplicationId · sha256 del canónico
  envelope        JSONB NOT NULL,     -- el sobre cifrado completo
  status          TEXT  NOT NULL DEFAULT 'PENDING',
  attempts        INT   NOT NULL DEFAULT 0,
  next_attempt    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at         TIMESTAMPTZ,
  last_error_code TEXT, last_error TEXT,
  e0_listo TIMESTAMPTZ, e1_canonizado TIMESTAMPTZ, e2_firmado TIMESTAMPTZ,
  e3_cifrado TIMESTAMPTZ, e4_commit TIMESTAMPTZ,
  e5_reclamado TIMESTAMPTZ, e6_publicado TIMESTAMPTZ,
  CONSTRAINT outbox_status_valido CHECK (status IN ('PENDING','SENT','FAILED'))
);
```

`envelope` en `JSONB` y no `TEXT` para poder inspeccionar `key_id` o `alg` en
una consulta cuando algo no cuadre. El contenido real sigue siendo opaco.

### El índice parcial

```sql
CREATE INDEX outbox_pendientes ON outbox (next_attempt) WHERE status = 'PENDING';
```

La tabla crece con todo lo enviado, pero **el índice solo contiene lo
pendiente** y se mantiene pequeño. El relay pregunta siempre lo mismo
—`status='PENDING' AND next_attempt <= now()`— y ése es exactamente el conjunto
que este índice cubre.

---

## La regla 2 · una transacción, dos escrituras

```sql
BEGIN;
  INSERT INTO expediente ... ON CONFLICT (rpf_id) DO UPDATE ...   -- negocio
  INSERT INTO outbox (rpf_id, payload_hash, envelope, e0..e4)     -- PENDING
COMMIT;
-- nada se publica aquí
```

Si fueran dos escrituras separadas **no tendrías un outbox**: tendrías dos
tablas que se desincronizan la primera vez que el proceso muera entre una y
otra. Con una transacción hay dos desenlaces y los dos son sanos: o están las
dos escrituras, o no está ninguna.

Y en este archivo **ni siquiera se importa el cliente de SQS**. Es la regla 3
hecha estructura, no disciplina.

---

## Una transacción por LOTE, no por evento

Con 20 documentos serían 20 `BEGIN`/`COMMIT` y 20 fsync donde basta uno. El
invariante se mantiene igual: cada fila de outbox sigue compartiendo transacción
con su expediente.

**El precio es que un fallo tumba el lote entero**, y es el precio correcto: un
fallo a esa altura es de la BASE —caída, disco lleno, deadlock—, no del
documento. Reintentar 19 de 20 no arreglaría nada y dejaría el lote a medias,
que es peor de reconciliar que un lote entero ausente.

Si la transacción falla, **el error sube y el lote no se contesta con 202**.
Decir «aceptado» tras un rollback sería una mentira que solo se descubre al
conciliar, cuando ya no hay forma de recuperarlos.

---

## Dos detalles que costaron encontrar

### El orden de los expedientes

Los UPSERT se hacen **ordenados por `rpf_id`**. Dos lotes concurrentes que tocan
los mismos expedientes en orden distinto se bloquean en cruz y Postgres mata uno
por deadlock.

### `GREATEST` / `LEAST`, no asignación

```sql
sequence_max = GREATEST(expediente.sequence_max, EXCLUDED.sequence_max)
```

Los eventos de un mismo expediente **llegan desordenados** — el orquestador
dispara sin esperar respuesta (O-02). Una asignación directa haría que
`sequence_max` retrocediera cuando llega uno viejo.

---

## Y un bug de relojes

`e4` y `e5` los estampa **el proceso**, no la base.

Antes usaban `clock_timestamp()` de Postgres, que daba precisión por fila dentro
del lote. Estaba mal, y costó un test intermitente descubrirlo: `e5` salía del
reloj de Postgres y `e6` del de Node, así que **el tramo `e5→e6` podía dar
negativo** cuando la publicación tardaba menos que la deriva entre los dos
relojes. En local son el contenedor Docker y el host; en AWS serían el RDS y la
tarea de Fargate.

M-06 acepta esa deriva **entre C3 y C4**, que están en cuentas distintas y no
hay alternativa. Dentro de C3 no hay excusa: `e0..e6` salen todas del reloj de
este proceso.

Lo que se pierde es la precisión por fila dentro de un lote. No importa: se
escriben en un solo `INSERT`, así que su instante real **es** el mismo.
