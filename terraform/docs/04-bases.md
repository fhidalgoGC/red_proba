# 04 — Las bases de datos

## Una instancia RDS por tenant, más la de C4

| | Recurso | Identificador | Clase | VPC |
|---|---|---|---|---|
| Por tenant | `aws_db_instance.esta` (`for_each`) | `rpf-one-db-NN` | `db.t4g.micro` | C3 |
| C4 | `aws_db_instance.esta` (`count`) | `rpf-one-c4-db` | `db.t4g.medium` | C4 |

Con 50 tenants son **51 instancias**. Todas Single-AZ, `storage_encrypted`, gp3,
20 GB (el mínimo de RDS), sin backups y sin snapshot final.

**No son contenedores.** Si la tarea del API muere, la base y su outbox
sobreviven — y eso es lo que hace posible demostrar gap detection de verdad y que
P4 no quede con asterisco.

## Por qué C4 lleva una clase más grande

Un tenant recibe ~40 ev/s. C4 recibe **todo** el tráfico: 2.000 ev/s en `50client`.

> ⚠ **La familia `t4g` es de ráfaga.** Funciona con créditos de CPU y al agotarlos
> se estrangula al baseline. Una corrida sostenida de 5 h a 2.000 ev/s los agota, y
> el síntoma es idéntico al throttling de KMS: la latencia crece, el outbox se
> llena y **ningún error lo explica**.
>
> Si al medir `50client` el intervalo `e9→e10` —persistencia en C4— crece sin que
> crezcan los otros, sospechar de esto **antes** que del código, y pasar a
> `db.m6g.large` (2 vCPU sin ráfaga, 8 GiB).

## RDS no escala a cero

Es la asimetría incómoda de la PoC. `desired_count=0` apaga las tareas de Fargate
en segundos; con RDS **la única forma de no pagar es destruir la instancia**.

```hcl
rds_activo = var.rds_persistente ? true : var.desired_count > 0
```

| `rds_persistente` | Qué pasa al apagar | Coste apagado |
|---|---|---|
| `false` (defecto) | **las 51 instancias se destruyen** — los datos se van | ~$0 de RDS |
| `true` | siguen vivas, los datos sobreviven | ~$2,10/día en `oneClient` |

Ponlo en `true` solo si los datos tienen que sobrevivir al apagado, y asume el
coste continuo. Para conservar la medición sin pagar por ello, la vía es exportar
las tablas a S3 antes de apagar — es lo que hace `destruir.sh` en su paso 2.

## La task definition existe aunque la base no

```hcl
{ name = "DB_HOST", value = try(aws_db_instance.esta[each.key].address, "rds-apagado") }
```

Con `rds_activo = false` la instancia no existe todavía. La task definition igual
se crea —es gratis— con un marcador, y al encender toma el endpoint real. Es lo
que permite aplicar la infra completa **antes** de que existan las imágenes o las
bases.

## DB subnet groups

Uno por dominio, sobre las subnets de la capa `datos`:

```hcl
resource "aws_db_subnet_group" "esta" {
  for_each   = toset(["c3", "c4"])
  subnet_ids = [for k, s in aws_subnet.datos : s.id if split("-", k)[0] == each.key]
}
```

> **RDS los exige y tienen que abarcar ≥2 AZ**, aunque la instancia sea Single-AZ.
> Por eso las subnets de datos ignoran `az_count` y siempre usan 2. Las de
> aplicación sí lo respetan, que es donde el ahorro importa: ahí viven los
> endpoints.

## Que el destroy sea limpio

```hcl
skip_final_snapshot     = true
deletion_protection     = false
backup_retention_period = 0
```

Sin `skip_final_snapshot`, el destroy exige un snapshot final que tarda y deja un
artefacto **facturando que nadie recuerda borrar**. Sin `backup_retention_period =
0`, cada instancia arrastra backups automáticos que también cuestan.

Es una PoC: lo que importa es que `destruir.sh` deje la cuenta en cero verificado.

## La cuota que muerde a los 40 clientes

```
RDS · 51 instancias (una por cliente + la de C4)
```

La cuota por defecto son **40 instancias por región**. Por encima, el `apply`
falla a mitad y deja media infraestructura montada. `terraform:deploy` avisa antes
de aplicar cuando pides más de 39:

```bash
aws service-quotas get-service-quota --service-code rds --quota-code L-7B6409FD
```

Los aumentos de cuota **tardan días**. Se piden con anticipación, igual que los de
KMS y Fargate.

## Lo que esto no demuestra

- **Alta disponibilidad.** Single-AZ, sin backups, sin snapshot final. Los datos
  sobreviven a que muera una tarea, no a que muera la instancia.
- **Aislamiento a nivel de cuenta.** El aislamiento entre tenants es por security
  group dentro de una VPC compartida.
