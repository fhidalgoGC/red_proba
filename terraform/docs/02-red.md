# 02 — La red

## Dos VPC, y ninguna conexión entre ellas

```
┌─ VPC C3 · 10.101.0.0/16 · PARTICIPANTE ──────────────┐
│                                                       │
│  sg-orq  [ driver de carga ]   ← andamio de prueba    │
│              │ 8080 · api-NN.poc.local                │
│              ▼                                        │
│  sg-tenant-01 [ API ] ←→ [ RDS ]   5432 auto-ref      │
│  sg-tenant-NN [ API ] ←→ [ RDS ]                      │
│                                                       │
│  endpoints: ecr.api · ecr.dkr · secretsmanager        │
│             kms · logs · sqs   +  gateway S3          │
└───────────────────────┬───────────────────────────────┘
                        │ SendMessage
                        ▼
                  ┌───────────┐
                  │ SQS FIFO  │
                  └─────┬─────┘
                        │ ReceiveMessage
                        ▼
┌─ VPC C4 · 10.102.0.0/16 · OPERADOR NEUTRO ───────────┐
│  sg-c4  [ consumidor ] ←→ [ RDS ]                     │
│  los mismos 6 endpoints + gateway S3                  │
└───────────────────────────────────────────────────────┘
```

**No hay una tercera VPC.** El orquestador vive dentro de la de C3, en su propio
security group.

## Por qué el orquestador no tiene VPC propia

Las dos alternativas con VPC separada se descartaron:

- **PrivateLink** obligaría a montar un NLB delante de los 50 API.
- **Peering** no cuesta por hora, pero deja una conexión entre VPC en el
  inventario — y el argumento de D-03 es justamente que **no hay ninguna**.

Con peering, un revisor que quiere comprobar «SQS es el único canal» tiene que
aceptar el razonamiento de «el peering no es transitivo». Sin él, mira el
diagrama y ve que no hay nada que aflojar. Esa diferencia es todo el valor.

Lo que separa a ORQ de los tenants es lo mismo que separa a un tenant de otro: el
security group. `sg-orq` **no aparece en el ingress de 5432 de ningún tenant**,
así que no alcanza ninguna base. Sale a 8080 hacia el CIDR de C3 y a 443 hacia
los endpoints, y no tiene **ninguna regla de entrada** — los SG son stateful, así
que las respuestas fluyen igual y C3 no puede iniciar nada hacia él. Es la
unidireccionalidad que daba PrivateLink, sin NLB.

## Aislamiento entre tenants · D-02

La app y su RDS comparten `sg-tenant-NN`. La regla de entrada a 5432 tiene como
**origen el propio grupo**:

```hcl
resource "aws_vpc_security_group_ingress_rule" "tenant_db" {
  for_each                     = toset(var.tenants)
  security_group_id            = aws_security_group.tenant[each.key].id
  referenced_security_group_id = aws_security_group.tenant[each.key].id   # ← él mismo
  from_port                    = 5432
  to_port                      = 5432
}
```

El descarte ocurre en la interfaz de red, antes de que el paquete toque el proceso
de Postgres. Mismo enforcement que separar VPC, con 50 recursos en vez de 50 redes.

> ⚠ **Falla en silencio.** Un error de índice en el `for_each` no rompe nada
> visible: simplemente el tenant 08 puede leer la base del 07. La única forma de
> detectarlo es la prueba explícita de conexión cruzada — desde la tarea del 08,
> `psql` contra el endpoint RDS del 07 **debe dar timeout**. Si da «password
> authentication failed», la conexión TCP se estableció y el aislamiento no
> existe.

**Trade-off**: dentro del grupo la app y la base se ven en ambos sentidos. Si esto
va a producción, separar `sg-app-NN` y `sg-db-NN`.

## Subnets: dos capas, ninguna con salida

| Capa | Dónde | Para qué |
|---|---|---|
| `app` | C3, C4 — `az_count` AZs | tareas de Fargate e interface endpoints |
| `datos` | C3, C4 — **siempre ≥2 AZ** | las instancias RDS |

Ninguna tiene ruta a `0.0.0.0/0`. No hay IGW ni NAT en toda la PoC. La separación
existe para poder darles reglas distintas más adelante, no para dar salida a una.

> **Las de datos ignoran `az_count`.** RDS exige un DB subnet group que abarque al
> menos 2 AZ *aunque la instancia sea Single-AZ*. Las de aplicación sí lo respetan,
> porque ahí viven los endpoints y son los que cobran por ENI: `az_count=1` ahorra
> la mitad del coste fijo sin romper RDS.

## VPC endpoints: reemplazan al NAT

Seis interface endpoints por VPC —`ecr.api`, `ecr.dkr`, `secretsmanager`, `kms`,
`logs`, `sqs`— más el gateway de S3. Sin ellos, una tarea no alcanza ningún
servicio de AWS.

> ⚠ **El gateway de S3 es obligatorio** aunque no uses S3 directamente: ECR guarda
> las **capas** de imagen en S3. Sin él el pull falla aunque tengas `ecr.api` y
> `ecr.dkr`, y el error dice `CannotPullContainerError`, que no apunta a S3 por
> ningún lado. Es gratis, y es el que se olvida.

Por eso el gateway **no sigue la perilla de encendido** y los interface endpoints
sí: los primeros no cuestan nada, los segundos ~$0,01/h **por ENI y por AZ**.

Cuando el orquestador tenía VPC propia hacían falta 15; ahora reutiliza los
`ecr`+`logs` de C3 y son **12**. Alcanzarlos por red no le da nada de C4: su task
role no tiene `sqs` ni `kms`.

## Cloud Map

| Namespace | VPC | Qué publica |
|---|---|---|
| `poc.local` | C3 | `api-NN.poc.local` — un registro por tenant |
| `c4.local` | C4 | nada todavía; existe para no compartir DNS con C3 |

Las bases **no entran**: RDS trae su propio endpoint DNS, y es el que va en
`DB_HOST`. Tampoco hay `aws_route53_zone_association`: el orquestador está en la
VPC donde vive la zona.

## La verificación de D-03, en el código

Que SQS sea el único canal no es una afirmación del diseño: es algo que se puede
comprobar en cinco greps.

| Qué | Cómo se comprueba | Resultado |
|---|---|---|
| Sin rutas entre VPC | `grep aws_route modules/network/` | **cero recursos** — solo la ruta local y el gateway de S3 |
| Sin peering / TGW / PrivateLink | no existe el recurso | ninguno, en ningún par |
| Sin SG cruzados | cada `cidr_ipv4` apunta al CIDR de su propio dominio | ninguna regla nombra el CIDR del otro |
| DNS separado | `poc.local` solo en C3, `c4.local` solo en C4 | sin asociaciones cruzadas |
| IAM | resource policy de la cola | solo `rol-c3` publica; solo `rol-c4` consume |

El último punto es el que más importa desde que ORQ está dentro de C3: **a nivel
de red alcanza el endpoint de SQS**. Lo que le impide tocar la cola es IAM — su
task role no tiene ni `sqs` ni `kms`, y la resource policy nombra únicamente a los
roles de C3 y C4.
