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

## Dos dominios, dos VPC

```
┌─ VPC C3 (participante) ────────────┐                ┌─ VPC C4 (operador) ─┐
│  orquestador  →  50 × (API + RDS)  │ → [SQS FIFO] → │  consumidor + RDS   │
└────────────────────────────────────┘                └─────────────────────┘
```

- **C3** es el dominio del participante. 50 tenants aislados entre sí por
  security group, **cada uno con su propia instancia RDS**. Firma y cifra.
- **C4** es el operador neutro. Descifra, verifica y persiste en **su propia
  instancia RDS**. **Nunca puede firmar.**
- **ORQ** es el arnés de carga y **corre dentro de la VPC de C3**, en su propio
  security group. No es un dominio de confianza: es andamio y desaparece con la
  prueba. Darle VPC propia obligaba a un peering, y un peering es justo la clase
  de ruta que alguien podría replicar después hacia C4.
- Entre C3 y C4 **no hay ruta de red**. El único canal es la cola — y al no
  existir la VPC de ORQ, **no hay ni una sola conexión entre VPC** en toda la
  infraestructura: sin peering, sin Transit Gateway, sin PrivateLink.

## Entregables

| Track | Qué es | Diseño | Implementación | Diagramas |
|---|---|---|---|---|
| `T` | Terraform: despliegue, apagado y destrucción | [06-infraestructura](docs/06-infraestructura.md) | [terraform/](terraform/) | — |
| `C` | Contenedor del cliente — NestJS en C3 | [03-contenedor-c3](docs/03-contenedor-c3.md) | [c3/docs/](c3/docs/README.md) | [🔗](https://claude.ai/code/artifact/6048693b-e9d9-45d1-9b8b-e2c8ab048a37) |
| `O` | Contenedor orquestador de carga | [04-orquestador](docs/04-orquestador.md) | [orquestador/docs/](orquestador/docs/README.md) | [🔗](https://claude.ai/code/artifact/caafc080-acc9-4c54-8951-3902e3e1ed1d) |
| `G` | Contenedor consumidor en C4 | [05-contenedor-c4](docs/05-contenedor-c4.md) | [c4/docs/](c4/docs/README.md) | [🔗](https://claude.ai/code/artifact/80828c05-58ef-4586-9ad8-80bb80d0a344) |

Orden sugerido: `C` y `T` en paralelo (ver "contrato de arranque" abajo),
luego `G`, luego `O`.

> **⚠ CAMBIO DE DISEÑO (vigente): el generador vive en el orquestador, no en C3.**
>
> El orquestador construye los documentos y se los manda hechos a cada tenant.
> El cuerpo del request pasó de `{ n }` a `{ lote_id, tenant_id, documentos }`.
> Los payloads ya **no pesan todos 3.072 bytes**: el documento tiene **70
> atributos hoja fijos** (+8 por ítem) y su tamaño se sortea en un rango
> (`[2048, 4096]` por defecto; el piso duro medido es 2.024 y el techo, 4.096,
> es el límite de `kms:Sign` con `MessageType: RAW`).
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

## Arranque local

Dos scripts en la raíz. **Verifican antes de actuar** y no hacen nada si ya está
todo como debe estar:

```bash
sh start              # verifica y levanta SOLO lo que falte
sh start --estado     # qué hay arriba
sh start --parar      # baja los cuatro (el Postgres se queda)
sh start --reiniciar  # baja y vuelve a levantar

sh reset-scratch      # vacía las tres bases y borra todos los logs
sh reset-scratch -y   # sin preguntar
```

| | Puerto | Swagger | Base |
|---|---|---|---|
| c3 tenant-01 | 3001 | `/docs` | `rpf_c3_tenant01` |
| c3 tenant-02 | 3002 | `/docs` | `rpf_c3_tenant02` |
| c4 consumidor | 3003 | `/docs` | `rpf_c4` |
| orquestador | 3000 | `/docs` | — |
| Postgres | 5433 | — | contenedor `cw-postgres` |

**Los cuatro responden `GET /health`, y en C3 y C4 ese `ok` sale de una consulta
real a la base.** Es la única verificación que prueba lo que importa: un pid
vivo solo dice que el proceso existe, un puerto abierto que alguien hizo
`listen`, y un `psql` desde fuera que Postgres está vivo — pero no que la
aplicación pueda entrar con sus credenciales. El del orquestador es el único que
no mira una base, porque no tiene: su `ok` es el pool de plantillas.

### Desplegar en AWS

```bash
sh terraform:deploy --clients 1   # la prueba inicial · 1 tenant (máximo 200)
sh terraform:deploy --down        # apagar: cómputo y endpoints a cero
sh terraform:deploy --estado      # qué hay desplegado
```

Entre corridas se **apaga**, no se destruye (T-07): deja de facturar cómputo en
segundos y conserva red, llaves, colas y datos. Para coste cero absoluto,
`terraform/scripts/destruir.sh oneClient`.

⚠ `reset-scratch` **no toca la cola SQS**: está en AWS y es compartida. Si
quedaron mensajes de la corrida anterior, C4 los insertará al arrancar y la
siguiente medición saldrá inflada. El script imprime el `purge-queue` para que
lo decidas tú.

## Contrato de arranque

Estas tres cosas se acuerdan **antes** de escribir código, porque desbloquean
que los tracks avancen en paralelo:

**1. Variables de entorno del contenedor C3** — una sola imagen para los 50:

```
TENANT_ID              # identificador del tenant
DB_HOST                # endpoint de su instancia RDS
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

- **Alta disponibilidad de las bases.** Cada tenant tiene su propia
  instancia RDS y C4 la suya, así que los datos sobreviven a que muera una
  tarea de Fargate — pero son Single-AZ, sin backups
  (`backup_retention_period = 0`) y sin snapshot final. Y como RDS no escala
  a cero, apagar con `rds_persistente = false` **borra las bases**.
- **Aislamiento a nivel de cuenta entre tenants.** El aislamiento es por
  security group dentro de una VPC compartida.
- **El orquestador como parte del producto.** Es arnés de prueba.
