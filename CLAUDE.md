# CLAUDE.md — PoC RPF Proof Ledger

Contexto de proyecto para Claude Code. Léelo completo antes de tocar código.

## Qué es esto

Prueba de concepto de un pipeline de eventos fiscales firmados y cifrados,
sobre AWS Fargate. Simula **50 clientes (tenants)** independientes, cada uno
con su propio contenedor de aplicación y su propio Postgres.

El objetivo de la PoC **no es** entregar producto. Es responder cuatro
preguntas con números:

| | Pregunta |
|---|---|
| P1 | ¿Cuánto tarda un documento de extremo a extremo? |
| P2 | ¿A qué ritmo sostenido procesa el sistema? |
| P3 | ¿Dónde está el límite y qué componente se satura primero? |
| P4 | ¿Llegaron todos los documentos a C4? |

Si al final hay contenedores que corrieron pero esas preguntas no tienen
respuesta, la PoC falló. **Toda decisión de implementación se juzga contra
eso.**

## Tres dominios, tres VPC

```
VPC ORQ  →  VPC C3 (participante)  →  [SQS FIFO]  →  VPC C4 (operador neutro)
orquestador   50 × (API + Postgres)                    consumidor + Postgres
```

- **C3** es el dominio del participante. 50 tenants aislados entre sí por
  security group. Firma y cifra.
- **C4** es el operador neutro. Descifra, verifica y persiste. **Nunca puede
  firmar.**
- **ORQ** es el arnés de carga. Es andamio: desaparece con la prueba.
- Entre C3 y C4 **no hay ruta de red**. El único canal es la cola.

## Entregables

| Track | Qué es | Doc |
|---|---|---|
| `T` | Terraform: despliegue, apagado y destrucción | [docs/06-infraestructura.md](docs/06-infraestructura.md) |
| `C` | Contenedor del cliente — NestJS en C3 | [docs/03-contenedor-c3.md](docs/03-contenedor-c3.md) |
| `O` | Contenedor orquestador de carga | [docs/04-orquestador.md](docs/04-orquestador.md) |
| `G` | Contenedor consumidor en C4 | [docs/05-contenedor-c4.md](docs/05-contenedor-c4.md) |

Orden sugerido: `C` y `T` en paralelo (ver "contrato de arranque" abajo),
luego `G`, luego `O`.

> **⚠ CAMBIO DE DISEÑO (vigente): el generador vive en el orquestador, no en C3.**
>
> El orquestador construye los documentos y se los manda hechos a cada tenant.
> El cuerpo del request pasó de `{ n }` a `{ lote_id, tenant_id, documentos }`.
> Los payloads ya **no pesan todos 3.072 bytes**: se sortean en un rango
> (`[1536, 3072]` por defecto; el piso duro medido es 1.403).
>
> Consecuencias: `e0` pasa a ser «C3 recibió el documento», el JCS es **código
> compartido** entre `O` y `C`, y `rpf_id`/`sequence` los decide el
> orquestador. `party_id` lo sigue escribiendo C3 (HMAC-SHA256 completo de
> KMS) sobre un placeholder de largo fijo de 69 caracteres, así el tamaño no
> se mueve.
>
> Detalle en [orquestador/README.md](orquestador/README.md).

## Documentos

1. [Arquitectura y decisiones](docs/01-arquitectura.md) — D-01 a D-11, el
   porqué de cada cosa. **Empieza aquí.**
2. [Payload](docs/02-payload.md) — forma, tamaño exacto, generador.
3. [Contenedor C3](docs/03-contenedor-c3.md) — API, firma, cifrado, outbox, relay.
4. [Orquestador](docs/04-orquestador.md) — perfil de carga, lazo abierto.
5. [Contenedor C4](docs/05-contenedor-c4.md) — consumo, descifrado, inbox.
6. [Infraestructura](docs/06-infraestructura.md) — inventario AWS y Terraform.
7. [Medición](docs/07-medicion.md) — marcas de tiempo, agregados, SQL.
8. [Límites y riesgos](docs/08-limites.md) — techos duros y cuotas.
9. [`party_id` y `payload_hash`](docs/09-party-id-y-payload-hash.md) — los dos
   artefactos del paso ② y por qué no son lo mismo.

## Contrato de arranque

Estas tres cosas se acuerdan **antes** de escribir código, porque desbloquean
que los tracks avancen en paralelo:

**1. Variables de entorno del contenedor C3** — una sola imagen para los 50:

```
TENANT_ID              # identificador del tenant
DB_HOST                # db-NN.poc.local
DB_SECRET_ARN          # credenciales en Secrets Manager
KMS_SIGN_KEY_ID        # llave Ed25519 en C3
KMS_HMAC_KEY_ID        # pseudonimización de tenant
KMS_ENCRYPT_KEY_ID     # llave simétrica de C4 (solo GenerateDataKey)
SQS_QUEUE_URL          # cola FIFO en C4
OUTBOX_POLL_MS=500
OUTBOX_BATCH_SIZE=10
OUTBOX_MAX_ATTEMPTS=10
OUTBOX_BACKOFF_CAP_SEC=300
```

**2. Formato del sobre** — lo que viaja en el cuerpo del mensaje SQS. Está en
[docs/02-payload.md](docs/02-payload.md#el-sobre). C3 y C4 dependen de él.

**3. Atributos del mensaje SQS**, en claro:

```
MessageGroupId          = rpf_id
MessageDeduplicationId  = payload_hash   (sha256 del canónico EN CLARO)
```

## Reglas que no se negocian

Cada una tiene una razón concreta y romperla invalida algo.

1. **Los importes son `string`, nunca `number`.** JCS serializa números como
   doubles; un importe en punto flotante rompe la verificación de la firma.
   Igual la chave de acesso de 44 dígitos.
2. **El outbox se escribe en la misma transacción que el estado de negocio.**
   Si van separados no tienes un outbox, tienes dos escrituras que se
   desincronizan.
3. **El commit ocurre antes de publicar a SQS**, nunca al revés.
4. **La entrega es al-menos-una-vez.** Los duplicados son funcionamiento
   normal, no anomalía. C4 es idempotente por diseño.
5. **`MessageDeduplicationId` explícito** (`payload_hash`), calculado sobre el texto en claro.
   AES-GCM usa IV distinto cada vez: la deduplicación por contenido de SQS
   nunca detectaría un duplicado. Desactivarla.
6. **Se firma primero y se cifra después.** La firma cubre el documento, no
   un cifrado que cualquiera pudo rehacer.
7. **C4 descifra pero no firma. C3 firma y cifra pero no descifra.** Es el
   invariante del Proof Ledger, y vive en las policies de KMS.
8. **Las marcas de tiempo nunca van dentro del payload.** El payload va
   firmado; meterle metadatos de medición cambiaría lo que se firma. Van en
   columnas de la fila del outbox y del inbox.
9. **Nada de `Math.random()` en lo que se firma.** PRNG con semilla: un evento
   cuya firma no verifica tiene que ser reproducible.
10. **Medir en bytes, no en caracteres.** `Buffer.byteLength`, siempre.
11. **El pool del orquestador nunca reenvía una plantilla tal cual.** Cada
    envío refresca `event_id`, `rpf_id`, `sequence` y `occurred_at`. Un payload
    idéntico produce el mismo `payload_hash` y SQS FIFO lo descarta **en silencio**
    durante 5 minutos: perderías la mayoría de los eventos y P4 daría un falso
    negativo, sin un solo error en los logs.
12. **El orquestador no reintenta.** Un reintento cuenta el mismo evento dos
    veces como carga ofrecida y falsea O-06, que es el resultado principal.

## Convenciones

- Node 22, TypeScript estricto, NestJS para C3 y C4.
- Terraform con `for_each` sobre la lista de tenants. Nunca 50 bloques
  copiados.
- Todo importe monetario se calcula en centavos enteros y se formatea al
  final.
- Los identificadores de tarea (`C-01`, `T-04`, `D-06`…) son estables:
  úsalos en commits y PRs.

## Lo que esta PoC NO demuestra

Decirlo de entrada evita que alguien lo descubra en la demo:

- **Recuperación ante fallo del Postgres.** Corre en Fargate con
  almacenamiento efímero; si la tarea muere se pierde su outbox. El diseño
  real usa RDS. No se puede demostrar Gap Detection real.
- **Aislamiento a nivel de cuenta entre tenants.** El aislamiento es por
  security group dentro de una VPC compartida.
- **El orquestador como parte del producto.** Es arnés de prueba.
