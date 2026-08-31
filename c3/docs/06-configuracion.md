# 06 · Configuración

Todo vive en **`c3/.env`**, que carga Node de forma nativa con `--env-file`.
Sin `dotenv`, sin dependencia nueva. La plantilla es `.env.ejemplo`; el `.env`
está en el `.gitignore`.

**La línea de comandos gana sobre el archivo**, así que se puede pisar
cualquier variable sin editarlo:

```bash
OUTBOX_POLL_MS=100 npm start
```

---

## Lo que distingue a un tenant de otro

Va en los scripts de `package.json`, no en el `.env`: una sola imagen sirve a
los 50 y lo único que cambia entre ellos es esto (D-07).

```jsonc
"start":   "TENANT_ID=tenant-01 C3_PORT=3001 DATABASE_URL=…/rpf_c3_tenant01 node --env-file=.env dist/main.js"
"start:2": "TENANT_ID=tenant-02 C3_PORT=3002 DATABASE_URL=…/rpf_c3_tenant02 node --env-file=.env dist/main.js"
```

---

## Las obligatorias

| Variable | Si falta |
|---|---|
| `DATABASE_URL` — o las piezas `DB_*` | **El proceso muere al arrancar.** Sin outbox, C3 contestaría 202 a eventos que nunca van a existir |
| `SQS_QUEUE_URL` | **El proceso muere.** Es la única salida: sin ella el outbox se llena y nada llega a C4, con el contenedor en verde y sin un solo error |

Las dos matan el arranque a propósito. Un contenedor mal configurado tiene que
morir al arrancar, no a los diez minutos con el primer evento que no puede
entregar.

### La base: entera, o en piezas

En local la URL llega entera en `DATABASE_URL`. **En Fargate no puede llegar
entera**, y no es una preferencia: la contraseña la inyecta ECS desde Secrets
Manager en su propia variable, y una task definition no sabe interpolar un
secreto dentro de otra variable. Así que allí llegan las piezas y `urlDeBase()`
—al pie de `src/config/config.service.ts`— arma la URL.

| Variable | Por defecto | |
|---|---|---|
| `DB_HOST` | — | endpoint de RDS. **Obligatoria** si no hay `DATABASE_URL` |
| `DB_USER` | — | **Obligatoria** si no hay `DATABASE_URL` |
| `DB_PASSWORD` | vacía | la inyecta ECS desde Secrets Manager |
| `DB_PORT` | `5432` | |
| `DB_NAME` | `poc` | |
| `DB_SSLMODE` | `no-verify` | |

`DATABASE_URL` gana si está puesta: las piezas son el camino alternativo, no
una capa encima.

**Por qué `no-verify` y no `require`.** RDS PostgreSQL 15+ trae
`rds.force_ssl=1`, así que la conexión en claro se rechaza — pero la CA de RDS
no está en el trust store de Node, y `require` la verificaría y fallaría con
«self-signed certificate in certificate chain». `no-verify` cifra el transporte
sin verificar la cadena, que es lo que corresponde a una base en una subnet sin
ruta a internet y alcanzable solo desde su propio security group. Contra el
Postgres local, que no habla TLS, va `DB_SSLMODE=disable`.

---

## Las llaves de KMS — las tres o ninguna

| Variable | Para qué |
|---|---|
| `KMS_SIGN_KEY_ID` | Ed25519, en el KMS de C3 |
| `KMS_HMAC_KEY_ID` | pseudonimización del participante |
| `KMS_ENCRYPT_KEY_ID` | llave simétrica de C4 — **solo `GenerateDataKey`** |

Poner unas sí y otras no **mata el arranque con el motivo escrito**. A medias
firmaría con KMS y cifraría en local, y el fallo aparecería recién en C4 como
«no descifra».

Las tres ausentes activan el **modo local** — ver
[03 · Criptografía](03-criptografia.md).

---

## Las perillas

| Variable | Por defecto | Qué hace |
|---|---|---|
| `C3_ESQUEMA` | `c3` | esquema dentro de la base del tenant |
| `C3_BD_POOL` | `10` | conexiones del pool |
| `C3_EVENTOS_POR_DATA_KEY` | `100` | cuántos eventos comparten una data key |
| `OUTBOX_POLL_MS` | `500` | cada cuánto despierta el relay |
| `OUTBOX_BATCH_SIZE` | `10` | filas por tick. **Tope de `SendMessageBatch`: 10** |
| `OUTBOX_MAX_ATTEMPTS` | `10` | intentos antes de `FAILED`. Se agotan en ~14 min |
| `OUTBOX_BACKOFF_CAP_SEC` | `300` | techo del backoff exponencial |
| `C3_BYTES_MIN` / `C3_BYTES_MAX` | `1024` / `4096` | rango de tamaño canónico aceptado |
| `C3_DELAY_MS` | — | ⚠ retardo artificial. **Perilla de PRUEBA, no del producto** |

`C3_BYTES_MIN` está por debajo del piso duro medido (1.433 bytes con un solo
ítem), así que **no puede rechazar un documento bien formado por chico**.

---

## `GET /health` — C-08

Consulta la base de verdad; `ok:false` si no contesta. Un 200 fijo no te avisa
de que un Postgres murió, y con el outbox caído C3 no puede entregar nada.

```jsonc
{ "ok": true, "base": true, "tenant": "tenant-01",
  "tareas": { "C-02": "mapper", "C-03": "firma", "C-04": "cifrado",
              "C-05": "outbox", "C-06": "relay" },
  "publica_a_sqs": true,
  "outbox": { "total": 803, "pendientes": 0, "enviados": 803, "fallidos": 0,
              "payload_hash_unicos": 803, "expedientes": 803, "intentos_max": 1 },
  "relay":  { "ticks": 87, "vueltas": 305, "publicados": 803, "pausas": 0,
              "ocupado": false, "pausado_ms": 0, "fallos_seguidos": 0 } }
```

**Lo que hay que mirar no es el `ok`.** Si `relay.ocupado` se queda en `true`
para siempre, el relay se congeló y los eventos se acumulan en silencio — con
el health en verde. Y `pausado_ms > 0` significa circuit breaker abierto.
