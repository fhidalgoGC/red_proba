# ── ORQ-06 · VPC peering ORQ -> C3 ───────────────────────────────────────
#
# Se descarto PrivateLink: obligaria a un NLB delante de los 50 API y no
# tiene ventaja aca. El peering no cobra por hora.
#
# NO ROMPE D-03: el peering no es transitivo. Conectar ORQ a C3 no le da a
# C3 ningun camino hacia C4. La ausencia de peering C3<->C4 es lo que
# sostiene "SQS es la unica ruta", y es una propiedad de la topologia, no
# una regla que alguien pueda aflojar.

resource "aws_vpc_peering_connection" "orq_c3" {
  vpc_id      = aws_vpc.esta["orq"].id
  peer_vpc_id = aws_vpc.esta["c3"].id
  auto_accept = true # misma cuenta y misma region

  tags = {
    Name   = "${var.name_prefix}-pcx-orq-c3"
    Domain = "shared"
  }
}

# Rutas en AMBAS tablas. Con una sola el trafico sale y no vuelve.
resource "aws_route" "orq_hacia_c3" {
  route_table_id            = aws_route_table.esta["orq"].id
  destination_cidr_block    = var.cidr_c3
  vpc_peering_connection_id = aws_vpc_peering_connection.orq_c3.id
}

resource "aws_route" "c3_hacia_orq" {
  route_table_id            = aws_route_table.esta["c3"].id
  destination_cidr_block    = var.cidr_orq
  vpc_peering_connection_id = aws_vpc_peering_connection.orq_c3.id
}
