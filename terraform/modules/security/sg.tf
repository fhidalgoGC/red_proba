# ── D-02 · Aislamiento entre tenants por SG auto-referenciado ────────────
#
# La app y su Postgres comparten sg-tenant-NN. La regla de entrada a 5432
# tiene como origen el PROPIO grupo.
#
# El descarte ocurre en la interfaz de red, antes de que el paquete toque
# el proceso de Postgres. Mismo enforcement que separar VPC, con 50
# recursos en vez de 50 redes.
#
# ⚠ FALLA EN SILENCIO. Un error de indice en el for_each no rompe nada
#   visible: simplemente el tenant 08 puede leer la base del 07. La unica
#   forma de detectarlo es la prueba explicita de conexion cruzada
#   (ver terraform/50client/README.md).
#
# Trade-off: dentro del grupo la app y la base se ven en ambos sentidos.
# Si esto va a produccion, separar sg-app-NN y sg-db-NN.

data "aws_ec2_managed_prefix_list" "s3" {
  name = "com.amazonaws.${data.aws_region.sg.region}.s3"
}

data "aws_region" "sg" {}

resource "aws_security_group" "tenant" {
  for_each = toset(var.tenants)

  name        = "${var.name_prefix}-sg-tenant-${each.key}"
  vpc_id      = var.vpc_ids["c3"]
  description = "Tenant ${each.key}: API + Postgres. Aislado del resto."

  tags = {
    Name   = "${var.name_prefix}-sg-tenant-${each.key}"
    Domain = "c3"
    Tenant = each.key
  }
}

# ── LA REGLA DEL AISLAMIENTO ──
# Origen = el propio grupo. Un tenant no alcanza la base de otro.
resource "aws_vpc_security_group_ingress_rule" "tenant_db" {
  for_each = toset(var.tenants)

  security_group_id            = aws_security_group.tenant[each.key].id
  referenced_security_group_id = aws_security_group.tenant[each.key].id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  description                  = "Postgres solo desde el mismo tenant"
}

# El API recibe carga del orquestador, que ahora corre en la MISMA VPC.
# Origen = sg-orq, no un CIDR: si manana ORQ cambia de subnet, la regla
# sigue valiendo.
resource "aws_vpc_security_group_ingress_rule" "tenant_api_desde_orq" {
  for_each = toset(var.tenants)

  security_group_id            = aws_security_group.tenant[each.key].id
  referenced_security_group_id = aws_security_group.orq.id
  from_port                    = 8080
  to_port                      = 8080
  ip_protocol                  = "tcp"
  description                  = "HTTP del orquestador"
}

# ── Egress ───────────────────────────────────────────────────────────────
# Sin NAT ni IGW no hay internet, pero el egress igual debe existir:
# sin reglas de salida la tarea no alcanza ni los VPC endpoints.

resource "aws_vpc_security_group_egress_rule" "tenant_https" {
  for_each = toset(var.tenants)

  security_group_id = aws_security_group.tenant[each.key].id
  cidr_ipv4         = var.vpc_cidrs["c3"]
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  description       = "HTTPS hacia los interface endpoints (KMS, SQS, ECR, Secrets, Logs)"
}

# ⚠ EL QUE SE OLVIDA. El gateway de S3 no vive en el CIDR de la VPC: el
#   trafico sale hacia IPs de S3, cubiertas por la prefix list. Sin esta
#   regla, ECR resuelve pero el pull de CAPAS falla — y el error dice
#   "CannotPullContainerError", que no apunta a S3 por ningun lado.
resource "aws_vpc_security_group_egress_rule" "tenant_s3" {
  for_each = toset(var.tenants)

  security_group_id = aws_security_group.tenant[each.key].id
  prefix_list_id    = data.aws_ec2_managed_prefix_list.s3.id
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  description       = "HTTPS hacia S3 (capas de imagen de ECR)"
}

resource "aws_vpc_security_group_egress_rule" "tenant_db" {
  for_each = toset(var.tenants)

  security_group_id            = aws_security_group.tenant[each.key].id
  referenced_security_group_id = aws_security_group.tenant[each.key].id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  description                  = "Hacia el Postgres del mismo tenant"
}

# ── C4 · un solo grupo para servicios y base ─────────────────────────────
resource "aws_security_group" "c4" {
  name        = "${var.name_prefix}-sg-c4"
  vpc_id      = var.vpc_ids["c4"]
  description = "Servicios del operador neutro y su Postgres"
  tags        = { Name = "${var.name_prefix}-sg-c4", Domain = "c4" }
}

resource "aws_vpc_security_group_ingress_rule" "c4_db" {
  security_group_id            = aws_security_group.c4.id
  referenced_security_group_id = aws_security_group.c4.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  description                  = "Postgres de C4 desde los servicios de C4"
}

resource "aws_vpc_security_group_egress_rule" "c4_https" {
  security_group_id = aws_security_group.c4.id
  cidr_ipv4         = var.vpc_cidrs["c4"]
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  description       = "HTTPS hacia los endpoints de C4"
}

resource "aws_vpc_security_group_egress_rule" "c4_s3" {
  security_group_id = aws_security_group.c4.id
  prefix_list_id    = data.aws_ec2_managed_prefix_list.s3.id
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  description       = "HTTPS hacia S3 (capas de ECR)"
}

resource "aws_vpc_security_group_egress_rule" "c4_db" {
  security_group_id            = aws_security_group.c4.id
  referenced_security_group_id = aws_security_group.c4.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

# ── ORQ · dentro de la VPC de C3 ─────────────────────────────────────────
#
# El orquestador NO tiene VPC propia. Es andamio de prueba, no un dominio
# de confianza: darle una VPC obligaba a un peering, y un peering es una
# ruta que alguien puede replicar despues hacia C4. Sin VPC de ORQ no hay
# peering en toda la PoC.
#
# Lo que separa a ORQ de los tenants sigue siendo lo mismo que separa a un
# tenant de otro: el security group. Vive en la VPC de C3 pero en su propio
# grupo, y ese grupo NO esta en el ingress de 5432 de ningun tenant — no
# alcanza ninguna base.
#
# SIN reglas de entrada, a proposito. Los security groups son stateful: las
# respuestas de C3 fluyen igual, y C3 no puede INICIAR nada hacia el
# orquestador. Es lo que recupera la unidireccionalidad que daba
# PrivateLink, sin montar un NLB.
resource "aws_security_group" "orq" {
  name        = "${var.name_prefix}-sg-orq"
  vpc_id      = var.vpc_ids["c3"]
  description = "Driver de carga, en la VPC de C3. Sin ingress: C3 no puede iniciar hacia aca."
  tags        = { Name = "${var.name_prefix}-sg-orq", Domain = "orq" }
}

resource "aws_vpc_security_group_egress_rule" "orq_hacia_c3" {
  security_group_id = aws_security_group.orq.id
  cidr_ipv4         = var.vpc_cidrs["c3"]
  from_port         = 8080
  to_port           = 8080
  ip_protocol       = "tcp"
  description       = "HTTP hacia los API de C3, misma VPC"
}

# Reutiliza los interface endpoints de C3 (ECR, logs). Alcanzarlos por red
# no le da nada de C4: su task role no tiene sqs ni kms, y la resource
# policy de la cola solo nombra a los roles de C3 y C4.
resource "aws_vpc_security_group_egress_rule" "orq_https" {
  security_group_id = aws_security_group.orq.id
  cidr_ipv4         = var.vpc_cidrs["c3"]
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  description       = "HTTPS hacia los endpoints de C3 (ECR, logs)"
}

resource "aws_vpc_security_group_egress_rule" "orq_s3" {
  security_group_id = aws_security_group.orq.id
  prefix_list_id    = data.aws_ec2_managed_prefix_list.s3.id
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  description       = "HTTPS hacia S3 (capas de ECR)"
}
