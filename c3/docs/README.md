# C3 — documentación del track `C`

El contenedor del participante. **Una sola imagen sirve a los 50 tenants**;
lo único que cambia entre ellos son variables de entorno (D-07).

Recibe documentos ya hechos del orquestador, los valida, los canoniza, los
firma, los cifra, los escribe en un outbox dentro de la transacción de negocio,
y un relay los publica en la cola FIFO de C4.

> **[Diagramas](diagramas.html)** — nueve diagramas: el pipeline etapa por etapa,
> KMS, el outbox, el relay, y cómo se toman y se guardan los tiempos. Es un
> HTML autocontenido: ábrelo desde el disco, sin servidor ni conexión. También
> publicado en
> [claude.ai](https://claude.ai/code/artifact/6048693b-e9d9-45d1-9b8b-e2c8ab048a37).

---

## Los documentos

| | Qué responde |
|---|---|
| [01 · El pipeline](01-pipeline.md) | Los seis pasos, en orden, y por qué ese orden |
| [02 · El contrato de atributos](02-contrato.md) | Qué valida, qué rechaza y con qué motivo |
| [03 · Criptografía](03-criptografia.md) | HMAC, JCS, firma, cifrado — y qué hace KMS y qué no |
| [04 · El outbox](04-outbox.md) | La tabla de la que sale todo lo que llega a C4 |
| [05 · El relay](05-relay.md) | El lazo, el backoff, el circuit breaker y el purgado |
| [06 · Configuración](06-configuracion.md) | El `.env`, las variables y qué pasa si faltan |
| [07 · Medición](07-medicion.md) | Las siete marcas `e0..e6`, **cómo se toma y se guarda el tiempo de cada paso**, el log por segundo y los números medidos |
| [08 · Reglas que no se negocian](08-reglas.md) | Las decisiones que si se rompen invalidan algo |

El **diseño** del track vive aparte, en
[../../docs/03-contenedor-c3.md](../../docs/03-contenedor-c3.md). Esto es la
implementación.

---

## Arranque rápido

```bash
docker start cw-postgres          # 127.0.0.1:5433

cd c3 && npm start                # :3001 tenant-01 → base rpf_c3_tenant01
cd c3 && npm run start:2          # :3002 tenant-02 → base rpf_c3_tenant02
```

Toda la configuración vive en **`c3/.env`** (plantilla en `.env.ejemplo`), que
carga Node de forma nativa con `--env-file` — sin `dotenv`. Lo que la línea de
comandos ponga gana sobre el archivo:

```bash
OUTBOX_POLL_MS=100 npm start
```

Swagger en `http://localhost:3001/docs`.

---

## Estado

| | Tarea | |
|---|---|---|
| `C-01` | Endpoint receptor | 🟡 recibe y procesa; falta encolar y contestar antes |
| `C-02` | Canonical Mapper | ✅ |
| `C-03` | Signer KMS Ed25519 | ✅ |
| `C-04` | Cifrado + caché de data key | ✅ |
| `C-05` | Outbox en la TX de negocio | ✅ |
| `C-06` | Relay a SQS FIFO | ✅ |
| `C-07` | Cierre ordenado en SIGTERM | ✅ |
| `C-08` | Health check real | ✅ |
| `C-09` | Marcas `e0..e6` | ✅ |
| `C-10` | Descarga del log (`GET /logs/<id>`) | ✅ |

**160 tests.** Los del mapper corren sin nada; los del outbox y el relay
necesitan Postgres; `npm run e2e:kms` necesita además AWS.
