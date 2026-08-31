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
