# 05 — Costes y perillas

> Las cifras son órdenes de magnitud, medidas en `us-west-2`. El número real de
> una corrida sale de `scripts/costos.sh`, que lee Cost Explorer —y **atrasa
> ~24 h**: la corrida de hoy se lee mañana.

## El baseline de la cuenta

**$0,0811/día**, plano, con variación de ±$0,00002. Es lo que gasta la cuenta sin
la PoC, y es lo que se resta para aislar una corrida.

La cuenta **no está vacía**: ya tiene un cluster ECS `cluster-test` y dos VPC
ajenas (`10.0.0.0/16`, `10.16.0.0/16`). Por eso la PoC arranca en `10.101` y por
eso el tag `Project` no es cosmético — filtrar por «linked account» mezclaría la
PoC con lo que ya vive ahí.

## Qué cuesta cada estado

| Estado | Qué factura | ~USD/día |
|---|---|---|
| **Destruido** | nada | $0 |
| **Apagado** | 4 llaves KMS ($1/mes c/u) + 1 secreto ($0,40/mes) | **$0,15** |
| **Encendido**, `az_count=1` | + 12 ENIs de endpoints + 2 RDS + Fargate | $2,88 + RDS + cómputo |
| **Encendido**, `az_count=2` | + 24 ENIs | $5,76 + RDS + cómputo |

**«Apagado» no es gratis, es barato** — y es casi el doble del baseline, así que se
nota en el reporte diario. Si la PoC va a quedar quieta más de una semana, conviene
`destruir.sh` en vez de `apagar.sh`.

## Las cuatro perillas

| Variable | Defecto | Qué mueve |
|---|---|---|
| `desired_count` | `0` | **la perilla maestra.** Tareas, endpoints y RDS la siguen |
| `az_count` | `1` en oneClient, `2` en el diseño | duplica el coste de endpoints |
| `endpoints_activos` | `null` → sigue a `desired_count` | forzar los endpoints fijos |
| `rds_persistente` | `false` → sigue a `desired_count` | que los datos sobrevivan al apagado |

Los interface endpoints siguen a la perilla **a propósito**. Si no lo hicieran,
estar «apagado» costaría ~$2,88/día con `az_count=1` — unas 35× el baseline, sin
nada corriendo. El precio a pagar: encender tarda unos minutos más mientras se
recrean y el DNS privado propaga.

El gateway de S3 es la excepción: **no sigue la perilla porque es gratis**, y es el
que se olvida.

## Con un tenant, `az_count=1`

La segunda AZ no ejercita nada: no hay reparto de carga ni tolerancia a fallo que
probar. `50client` sube a 2, que es lo que pide el diseño. **El código es idéntico
— cambia el número, no la estructura.**

Ojo: las subnets de datos usan 2 AZ igual, porque RDS lo exige. `az_count` solo
afecta a la capa de aplicación, que es donde viven los endpoints.

## El renglón que domina bajo carga

No es ninguno de los anteriores: es **KMS**, porque hay una llamada `Sign` **por
evento**. A 2.000 ev/s durante horas, ese renglón se come a todos los demás. Las
guardas de coste del despliegue lo dicen explícitamente antes de aplicar.

## El presupuesto vive en Terraform, no en un recordatorio

```hcl
resource "aws_budgets_budget" "poc" {
  limit_amount = var.presupuesto_mensual_usd   # "50"
  # avisos a 50%, 80% y 100% real, más 100% proyectado
}
```

El aviso **proyectado** es el que sirve: llega antes de gastarlo.

> ⚠ El budget **no filtra por tag** a propósito. Filtrar por `TagKeyValue` exige que
> la cost allocation tag esté **activada**, y esta cuenta es miembro de una org:
> solo el payer puede activarla. Un budget a nivel cuenta funciona hoy, sin depender
> de nadie, y con este baseline es señal suficiente.

## Las tags

Se aplican con `default_tags` en el provider, así que cubren todo recurso que
soporte tags sin repetir una línea.

| Tag | Valores | Para qué |
|---|---|---|
| `Project` | `rpf-proof-ledger` | discriminador principal |
| `Scenario` | `oneClient` · `50client` | separa la prueba de humo del run caro |
| `Run` | `2026-08-29-humo` | identificador de corrida; se bumpea antes de cada carga |
| `Track` | `T` `C` `G` `O` | qué track paga cada recurso |
| `Domain` | `c3` `c4` `orq` `shared` | coste por dominio |
| `Tenant` | `01`…`50` | con Zipf, revela si el tenant pesado cuesta más |

> ⚠ **Las tags tienen que existir antes del gasto.** Cost Explorer no etiqueta
> retroactivamente. Un `apply` sin tags es un agujero permanente en el reporte: no
> se arregla después. Tagear desde el primer `apply`, activar cuando se pueda — al
> revés no funciona.

## Una corrida de carga por día

La granularidad **horaria** de Cost Explorer está bloqueada: requiere opt-in del
payer. Con granularidad diaria, dos corridas el mismo día no se pueden separar sin
el tag `Run` activado.

Consecuencia práctica, y hay que planificarla: **una corrida por día**.

## Las cuotas que no se arreglan reintentando

| Servicio | Umbral | Qué pasa al pasarlo |
|---|---|---|
| **RDS** | 40 instancias/región | el `apply` falla a mitad, con media infra montada |
| **KMS** | 1.000 ops/s (pedir 3.000) | la latencia crece y ningún error lo explica |
| **Fargate** | vCPU por región | las tareas no arrancan |

Los tres aumentos **tardan días**. Ver [../../docs/08-limites.md](../../docs/08-limites.md).
