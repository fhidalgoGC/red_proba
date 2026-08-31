# ── D-01 · Una VPC por dominio de confianza ──────────────────────────────
#
# Tres VPC, CIDR sin traslape. El traslape no es estetico: el peering
# ORQ<->C3 falla al crearse si chocan (requisito de ORQ-06).
#
# ⚠ La cuenta ya tiene 10.0.0.0/16 (VPC_ACCESS-vpc) y 10.16.0.0/16
#   (TEST-APP-vpc), ajenas a esta PoC. Por eso arrancamos en 10.100.

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
    orq = { cidr = var.cidr_orq, domain = "orq" }
    c3  = { cidr = var.cidr_c3, domain = "c3" }
    c4  = { cidr = var.cidr_c4, domain = "c4" }
  }

  # Interface endpoints. Sin NAT ni IGW, esto es la UNICA forma de que una
  # tarea alcance un servicio de AWS.
  #
  # ORQ necesita ecr+logs para poder arrancar su propia imagen. El doc no lo
  # lista, pero sin endpoints ORQ no puede hacer pull y la tarea nunca sale
  # de PROVISIONING.
  endpoints = {
    c3  = ["ecr.api", "ecr.dkr", "secretsmanager", "kms", "logs", "sqs"]
    c4  = ["ecr.api", "ecr.dkr", "secretsmanager", "kms", "logs", "sqs"]
    orq = ["ecr.api", "ecr.dkr", "logs"]
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
# Sin rutas a 0.0.0.0/0 en ningun lado. Solo local, mas el peering ORQ<->C3.

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
