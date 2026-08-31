# ── D-01 · Una VPC por dominio de confianza ──────────────────────────────
#
# DOS VPC: C3 (participante) y C4 (operador neutro). Son los dos dominios
# de confianza reales, y entre ellos NO hay ninguna ruta: la cola es el
# unico canal (D-03).
#
# El orquestador NO tiene VPC propia: vive dentro de la de C3, con su
# propio security group. Es andamio de prueba, no un dominio de confianza
# — darle una VPC solo anadia un peering que mantener, y un peering es
# justo el tipo de cosa que alguien podria replicar despues hacia C4.
# Sin VPC de ORQ no hay peering en toda la PoC, y "no hay camino" deja de
# depender de que nadie toque una tabla de rutas.
#
# ⚠ La cuenta ya tiene 10.0.0.0/16 (VPC_ACCESS-vpc) y 10.16.0.0/16
#   (TEST-APP-vpc), ajenas a esta PoC. Por eso arrancamos en 10.101.

data "aws_availability_zones" "disponibles" {
  state = "available"
}

locals {
  azs = slice(data.aws_availability_zones.disponibles.names, 0, var.az_count)

  # ⚠ RDS EXIGE un DB subnet group que abarque AL MENOS 2 AZ, aunque la
  #   instancia sea Single-AZ. Por eso las subnets de datos ignoran
  #   az_count y siempre usan 2.
  #
  #   Las de aplicacion SI respetan az_count: ahi viven los interface
  #   endpoints, que son los que cobran por ENI. Asi az_count=1 sigue
  #   ahorrando la mitad del costo de endpoints sin romper RDS.
  az_datos  = max(var.az_count, 2)
  azs_datos = slice(data.aws_availability_zones.disponibles.names, 0, max(var.az_count, 2))

  vpcs = {
    c3 = { cidr = var.cidr_c3, domain = "c3" }
    c4 = { cidr = var.cidr_c4, domain = "c4" }
  }

  # Interface endpoints. Sin NAT ni IGW, esto es la UNICA forma de que una
  # tarea alcance un servicio de AWS.
  #
  # El orquestador usa los de C3 -ecr+logs- porque corre en esa VPC. Sin
  # ellos no puede hacer pull de su imagen y la tarea nunca sale de
  # PROVISIONING. Alcanzarlos a nivel de red no le da nada de C4: su task
  # role no tiene sqs ni kms, y la resource policy de la cola solo nombra
  # a los roles de C3 y C4.
  #
  # `ssmmessages` es el de ECS Exec, y sin el no hay forma de LANZAR una
  # corrida: el POST /batch del orquestador vive en una subnet privada y no hay
  # IGW, NAT ni balanceador que lleve hasta ahi. Es una sesion saliente, no un
  # puerto abierto — ver modules/security/exec.tf.
  endpoints = {
    c3 = ["ecr.api", "ecr.dkr", "secretsmanager", "kms", "logs", "sqs", "ssmmessages"]
    c4 = ["ecr.api", "ecr.dkr", "secretsmanager", "kms", "logs", "sqs", "ssmmessages"]
  }
}

resource "aws_vpc" "esta" {
  for_each = local.vpcs

  cidr_block           = each.value.cidr
  enable_dns_support   = true
  enable_dns_hostnames = true # requisito del private DNS de los endpoints

  tags = {
    Name   = "${var.name_prefix}-vpc-${each.key}"
    Domain = each.value.domain
  }
}

# ── Subnets ──────────────────────────────────────────────────────────────
# Dos capas: aplicacion y datos. NINGUNA tiene ruta a internet — no hay IGW
# ni NAT en toda la PoC. La separacion es para poder darles reglas distintas
# mas adelante, no para dar salida a una de ellas.

resource "aws_subnet" "app" {
  for_each = {
    for par in setproduct(keys(local.vpcs), range(var.az_count)) :
    "${par[0]}-${par[1]}" => { vpc = par[0], idx = par[1] }
  }

  vpc_id            = aws_vpc.esta[each.value.vpc].id
  availability_zone = local.azs[each.value.idx]
  cidr_block        = cidrsubnet(local.vpcs[each.value.vpc].cidr, 8, each.value.idx + 1)

  tags = {
    Name   = "${var.name_prefix}-${each.value.vpc}-app-${each.value.idx}"
    Domain = local.vpcs[each.value.vpc].domain
    Capa   = "app"
  }
}

resource "aws_subnet" "datos" {
  for_each = {
    for par in setproduct(["c3", "c4"], range(local.az_datos)) :
    "${par[0]}-${par[1]}" => { vpc = par[0], idx = par[1] }
  }

  vpc_id            = aws_vpc.esta[each.value.vpc].id
  availability_zone = local.azs_datos[each.value.idx]
  cidr_block        = cidrsubnet(local.vpcs[each.value.vpc].cidr, 8, each.value.idx + 11)

  tags = {
    Name   = "${var.name_prefix}-${each.value.vpc}-datos-${each.value.idx}"
    Domain = local.vpcs[each.value.vpc].domain
    Capa   = "datos"
  }
}

# ── Tablas de ruta ───────────────────────────────────────────────────────
# Solo la ruta local de cada VPC, mas el gateway de S3. Sin 0.0.0.0/0, sin
# peering, sin Transit Gateway: no hay NINGUNA entrada que lleve de C3 a C4
# ni al reves. Eso es D-03 escrito en la topologia.

resource "aws_route_table" "esta" {
  for_each = local.vpcs

  vpc_id = aws_vpc.esta[each.key].id
  tags = {
    Name   = "${var.name_prefix}-rt-${each.key}"
    Domain = each.value.domain
  }
}

resource "aws_route_table_association" "app" {
  for_each       = aws_subnet.app
  subnet_id      = each.value.id
  route_table_id = aws_route_table.esta[split("-", each.key)[0]].id
}

resource "aws_route_table_association" "datos" {
  for_each       = aws_subnet.datos
  subnet_id      = each.value.id
  route_table_id = aws_route_table.esta[split("-", each.key)[0]].id
}

# ── DB subnet groups · uno por dominio ───────────────────────────────────
# RDS los exige y tienen que abarcar >=2 AZ.

resource "aws_db_subnet_group" "esta" {
  for_each = toset(["c3", "c4"])

  name       = "${var.name_prefix}-${each.key}"
  subnet_ids = [for k, s in aws_subnet.datos : s.id if split("-", k)[0] == each.key]

  tags = {
    Name   = "${var.name_prefix}-dbsubnet-${each.key}"
    Domain = each.key
  }
}
