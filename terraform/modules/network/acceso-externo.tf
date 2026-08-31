# ── ACCESO EXTERNO · la puerta que normalmente NO existe ─────────────────
#
# ⚠ ESTE ARCHIVO ROMPE UNA PROMESA DEL DISENO, a peticion explicita y detras
#   de una perilla que por defecto esta apagada.
#
# El resto de `network/` dice, con razon, que NINGUNA subnet tiene ruta a
# internet: no hay IGW ni NAT en toda la PoC, y los servicios de AWS se
# alcanzan por interface endpoints. Mientras `acceso_externo = true`, eso deja
# de ser cierto: hay un Internet Gateway por VPC y una ruta 0.0.0.0/0.
#
# ── Que NO rompe ────────────────────────────────────────────────────────────
#
# El invariante que la PoC demuestra es que NO HAY CAMINO ENTRE C3 Y C4. Eso
# sigue intacto: cada IGW da salida a internet desde SU vpc, y ninguna ruta
# apunta al CIDR de la otra. Sin peering, sin Transit Gateway, sin PrivateLink.
# Un paquete de C3 no llega a C4 ni pasando por el IGW: la 10.102.0.0/16 no es
# enrutable en internet.
#
# ── Que SI rompe, y hay que decirlo en la demo ──────────────────────────────
#
# Con esto encendido, las dos RDS y las tres tasks tienen endpoint publico. La
# UNICA defensa es el security group atado a un /32 (ver modules/security). La
# corrida de medicion de verdad se hace con `acceso_externo = false`, y el
# informe tiene que decir con que valor se corrio.
#
# ── Coste ───────────────────────────────────────────────────────────────────
#
# El IGW es gratis. Lo que se paga son las IPv4 publicas, a $0,005/h cada una
# ($0,12/dia): una por task con `assign_public_ip` y una por RDS con
# `publicly_accessible`. Con 1 tenant son 5 = ~$0,60/dia.
#
# Apagar el despliegue (`--down`) las quita todas: sin tasks y sin RDS no hay
# nada a lo que atar una IP. El IGW se queda y no cuesta nada.

resource "aws_internet_gateway" "esta" {
  for_each = var.acceso_externo ? local.vpcs : {}

  vpc_id = aws_vpc.esta[each.key].id

  tags = {
    Name   = "${var.name_prefix}-igw-${each.key}"
    Domain = each.value.domain
    Nota   = "acceso_externo=true - temporal"
  }
}

# Una sola tabla de rutas por VPC, compartida por las subnets de app y de
# datos. Por eso esta ruta habilita las dos capas a la vez — y hace falta:
# la RDS publica vive en `datos` y las tasks con IP publica en `app`.
#
# ⚠ Una subnet con ruta a IGW no da internet por si sola. Una task SIN IP
#   publica en esta subnet sigue sin salida: no hay NAT. Lo que expone es la
#   IP publica, no la ruta.
resource "aws_route" "hacia_internet" {
  for_each = var.acceso_externo ? local.vpcs : {}

  route_table_id         = aws_route_table.esta[each.key].id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.esta[each.key].id
}
