# ── VPC Endpoints ────────────────────────────────────────────────────────
#
# Reemplazan al NAT Gateway. Con 100+ descargas de imagen el NAT seria el
# gasto de red dominante, y ademas abriria salida a internet donde no debe
# haberla.
#
# ⚠ EL GATEWAY DE S3 ES OBLIGATORIO aunque no uses S3 directamente:
#   ECR guarda las CAPAS de imagen en S3. Sin el, el pull falla aunque
#   tengas ecr.api y ecr.dkr. Es gratis, y es el que se olvida.

data "aws_region" "actual" {}

resource "aws_security_group" "endpoints" {
  for_each = var.endpoints_activos ? local.endpoints : {}

  name_prefix = "${var.name_prefix}-vpce-${each.key}-"
  vpc_id      = aws_vpc.esta[each.key].id
  description = "HTTPS hacia los interface endpoints desde dentro de la VPC"

  tags = {
    Name   = "${var.name_prefix}-sg-vpce-${each.key}"
    Domain = local.vpcs[each.key].domain
  }

  lifecycle { create_before_destroy = true }
}

# Solo 443 y solo desde el CIDR de la propia VPC.
resource "aws_vpc_security_group_ingress_rule" "endpoints_https" {
  for_each = var.endpoints_activos ? local.endpoints : {}

  security_group_id = aws_security_group.endpoints[each.key].id
  cidr_ipv4         = local.vpcs[each.key].cidr
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  description       = "HTTPS desde la VPC"
}

resource "aws_vpc_endpoint" "interfaz" {
  # Sin endpoints activos no se crea ninguno: es la diferencia entre que
  # estar apagado cueste $7,20/dia o ~$0.
  for_each = !var.endpoints_activos ? {} : {
    for par in flatten([
      for vpc, servicios in local.endpoints : [
        for s in servicios : { vpc = vpc, servicio = s }
      ]
    ]) : "${par.vpc}-${par.servicio}" => par
  }

  vpc_id              = aws_vpc.esta[each.value.vpc].id
  service_name        = "com.amazonaws.${data.aws_region.actual.region}.${each.value.servicio}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = [for k, s in aws_subnet.app : s.id if split("-", k)[0] == each.value.vpc]
  security_group_ids  = [aws_security_group.endpoints[each.value.vpc].id]
  private_dns_enabled = true

  tags = {
    Name   = "${var.name_prefix}-vpce-${each.value.vpc}-${each.value.servicio}"
    Domain = local.vpcs[each.value.vpc].domain
  }
}

# Gateway endpoint de S3. GRATIS — sin cargo por hora ni por dato.
# Por eso este NO sigue a endpoints_activos: no cuesta nada dejarlo, y es
# el que se olvida.
resource "aws_vpc_endpoint" "s3" {
  for_each = local.vpcs

  vpc_id            = aws_vpc.esta[each.key].id
  service_name      = "com.amazonaws.${data.aws_region.actual.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.esta[each.key].id]

  tags = {
    Name   = "${var.name_prefix}-vpce-${each.key}-s3"
    Domain = each.value.domain
  }
}
