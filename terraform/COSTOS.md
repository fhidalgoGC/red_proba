# Costos — atribución y reporte

> **Las tags tienen que existir antes del gasto.** Cost Explorer no etiqueta
> retroactivamente uso pasado. Un `apply` sin tags es un agujero permanente en
> el reporte: no se arregla después.

## Lo que encontramos en la cuenta

| | |
|---|---|
| Cuenta | `276076558677` |
| Organization | `o-uilsxig1sg`, management **`324005485665`** (lmacias@vergedata.com) |
| Rol de la cuenta | **miembro (linked)**, no standalone |
| Gasto del mes en curso | **$2,42** — prácticamente ruido |
| Ya corriendo | cluster ECS `cluster-test`, 2 VPC (`10.0.0.0/16`, `10.16.0.0/16`), algo de RDS/S3 |
| Cost Explorer | **lectura sí funciona** desde esta cuenta |
| Activar cost allocation tags | ❌ **NO se puede desde acá** |

```
$ aws ce list-cost-allocation-tags
AccessDeniedException: Linked account doesn't have access to cost allocation tags.
```

### Las tres consecuencias

**1. Activar las tags requiere la cuenta management.** Solo el payer
(`324005485665`) puede activar claves de tag como dimensión de costo. Hay que
pedirlo — y **tarda hasta 24 h** en empezar a aparecer en Cost Explorer.
Es de la misma familia que los aumentos de cuota: se pide con anticipación.

**2. Pero tagear no depende de eso.** Las tags se escriben en el CUR igual,
estén activadas o no. La activación solo habilita *agrupar por ellas* en Cost
Explorer. **Entonces: tagear desde el primer `apply`, activar cuando se pueda.**
Al revés no funciona.

**3. La cuenta no está vacía.** Filtrar el costo por "linked account" mezclaría
la PoC con lo que ya vive ahí. Por eso el tag `Project` no es cosmético: es el
discriminador. Y por eso `verificar-limpio.sh` filtra por tag — si no, reporta
`cluster-test` y las 2 VPC preexistentes como basura nuestra.

## El esquema de tags

Se aplican con `default_tags` en el provider, así que **cubren todo recurso que
soporte tags sin repetir una línea**.

| Tag | Valores | Para qué |
|---|---|---|
| `Project` | `rpf-proof-ledger` | Discriminador principal. Separa la PoC de lo preexistente. |
| `Scenario` | `oneClient` · `50client` | **Separa la prueba de humo del run de $540.** |
| `Run` | `2026-08-29-humo` | Identificador de corrida. Se bumpea antes de cada carga. |
| `Track` | `T` `C` `G` `O` | Qué track paga cada recurso. |
| `Domain` | `c3` `c4` `orq` `shared` | Costo por dominio de confianza. |
| `Tenant` | `01`…`50` · `shared` | Solo recursos por tenant. Con Zipf, revela si el tenant pesado cuesta más. |
| `ManagedBy` | `terraform` | Distingue lo aplicado de lo creado a mano. |
| `Owner` | `fhidalgo@grainchain.io` | A quién preguntarle. |

### Por qué `Run` es una tag y no una nota

El costo ya facturado **conserva el valor de tag que tenía en ese momento**.
Cambiar `Run` entre corridas no reescribe el pasado: cada corrida queda con su
etiqueta. Es lo que permite decir "la corrida del martes costó $X" en vez de
"agosto costó $Y".

Cambiar el valor **no recrea recursos** — las tags se actualizan en sitio.

## Lo que las tags NO capturan

Decirlo de entrada evita conclusiones falsas al leer el reporte:

- **Transferencia de datos entre AZ** — se factura, y en buena medida no se
  atribuye a un recurso etiquetado. Con 2 AZ y 2.000 ev/s no es trivial.
- **Peticiones a KMS** — el renglón dominante (~$540). El cargo va contra la
  llave; conviene **confirmarlo en el primer reporte real**, no asumirlo.
- **Tareas de Fargate** — no heredan las tags del service por defecto. Hace
  falta `enable_ecs_managed_tags = true` y `propagate_tags = "SERVICE"` en cada
  `aws_ecs_service`. **Sin eso el cómputo, que son ~106 tareas, queda sin
  atribuir.**
- **Cost Explorer atrasa ~24 h.** No sirve para vigilar una corrida en vivo.

## Vigilancia en vivo ≠ Cost Explorer

Para el requisito "que no cause gastos", los controles reales son otros:

| Control | Cuándo | Qué hace |
|---|---|---|
| `scripts/apagar.sh` | entre corridas | `desired_count=0`. Corta el cómputo en segundos. |
| `scripts/verificar-limpio.sh` | tras cada destroy | Lista lo que quedó vivo **con nuestro tag**. |
| AWS Budget | siempre | Alerta por umbral. Dado el baseline de $2,42, uno a nivel cuenta ya es señal fuerte. |
| `scripts/costos.sh` | al día siguiente | El número real, cuando CE ya consolidó. |

## Activación — pedido al payer

Mandarle esto a `lmacias@vergedata.com` (management `324005485665`):

> Necesito activar estas claves de cost allocation tag definidas por el usuario,
> para la cuenta miembro `276076558677`:
> `Project`, `Scenario`, `Run`, `Track`, `Domain`, `Tenant`, `ManagedBy`, `Owner`
>
> Billing → Cost allocation tags → User-defined → activar.

Equivalente por CLI, **desde la cuenta management**:

```bash
aws ce update-cost-allocation-tags-status --cost-allocation-tags-status \
  TagKey=Project,Status=Active   TagKey=Scenario,Status=Active \
  TagKey=Run,Status=Active       TagKey=Track,Status=Active \
  TagKey=Domain,Status=Active    TagKey=Tenant,Status=Active \
  TagKey=ManagedBy,Status=Active TagKey=Owner,Status=Active
```

Una clave solo se puede activar **después** de que existe en algún recurso. Así
que el orden es: `apply` de `oneClient` primero (crea las tags), pedido al payer
después. El `apply` de humo cuesta centavos — sirve de sembrado.

## Por día — la salida que no depende del payer

**Esta es la vía principal.** La granularidad diaria funciona hoy desde la
cuenta miembro, sin activación de tags y sin pedirle nada a nadie.

```
$ scripts/costos.sh dias 7

  FECHA               TOTAL    DE LA POC
  2026-08-22         0.0811       0.0000
  2026-08-23         0.0811       0.0000
  ...
```

### Por qué funciona tan bien acá

El baseline de la cuenta es **$0,0811/día, plano**, con variación de ±$0,00002
en 7 días medidos. Y el desglose dice por qué es tan estable:

| Servicio | $/día | |
|---|---|---|
| EC2 - Other | 0,0796 | 98% — almacenamiento/IPs, **costo fijo** |
| RDS | 0,0012 | |
| S3 | 0,0003 | |
| resto | ~0 | |

No hay nada elástico corriendo. Entonces:

```
costo de la corrida = total del día − 0,0811
```

Un día que vuelve a $0,0811 es la confirmación de que la PoC **no dejó nada
encendido** — la misma pregunta que contesta `verificar-limpio.sh`, pero por el
lado de la factura.

### La consecuencia: una corrida de carga por día

La granularidad **horaria está bloqueada** — también requiere opt-in del payer,
y encima es feature pago:

```
$ aws ce get-cost-and-usage --granularity HOURLY
AccessDeniedException: Hourly data granularity is an opt-in only feature.
You can enable this feature from the PAYER account's Cost Explorer Settings page.
```

Sin horaria y sin el tag `Run` activado, **dos corridas el mismo día no se
pueden separar**. Con una por día, el número sale limpio sin depender de nadie.

Si en algún momento hacen falta dos el mismo día, ahí sí hay que pedir la
activación de `Run` al payer — pero no antes.

### Ojo con el atraso

Cost Explorer consolida con ~24 h de atraso. **La corrida de hoy se lee
mañana.** El día en curso aparece parcial y el script lo marca.

## Reportar

```bash
scripts/costos.sh dias 14        # ← principal: por día, con delta vs baseline
scripts/costos.sh dia 2026-08-30 # un día, desglosado por servicio
scripts/costos.sh inventario     # qué existe vivo hoy con nuestro tag
scripts/costos.sh resumen        # mes en curso por servicio
scripts/costos.sh tags           # por Scenario/Run — requiere activación del payer
```

| Comando | ¿Necesita al payer? | Contesta |
|---|---|---|
| `dias` | **no** | ¿cuánto costó cada día? |
| `dia` | **no** | ¿en qué servicio se fue? |
| `inventario` | **no** | ¿qué hay vivo ahora? |
| `resumen` | **no** | ¿cómo va el mes? |
| `tags` | **sí** | ¿cuánto costó cada tenant/track? |

Las primeras cuatro cubren el reporte de costos completo. `tags` es refinamiento
—desglose *dentro* de la PoC—, no un requisito.

`inventario` funciona **hoy**, sin el payer: usa la Resource Groups Tagging API,
que no depende de la activación de cost allocation tags. Contesta "¿qué hay
vivo?", que es la pregunta urgente. `tags` contesta "¿cuánto costó cada cosa?",
que puede esperar 24 h.
