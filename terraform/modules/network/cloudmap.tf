# ── Cloud Map · api-NN.poc.local ─────────────────────────────────────────
#
# La zona vive en la VPC de C3 y el orquestador corre en esa misma VPC, asi
# que resuelve api-NN.poc.local sin asociacion de zona ni balanceador. Antes
# hacia falta un aws_route53_zone_association hacia la VPC de ORQ; con ORQ
# dentro de C3 sobra.
#
# Las bases no entran aca: RDS trae su propio endpoint DNS.

resource "aws_service_discovery_private_dns_namespace" "poc" {
  name        = var.namespace
  vpc         = aws_vpc.esta["c3"].id
  description = "Descubrimiento interno de C3. El orquestador corre aca dentro."

  tags = {
    Name   = "${var.name_prefix}-ns-${var.namespace}"
    Domain = "c3"
  }
}

# C4 tiene su propio namespace: no comparte DNS con C3 ni con ORQ.
resource "aws_service_discovery_private_dns_namespace" "c4" {
  name        = "c4.local"
  vpc         = aws_vpc.esta["c4"].id
  description = "Descubrimiento interno de C4. Aislado de C3."

  tags = {
    Name   = "${var.name_prefix}-ns-c4.local"
    Domain = "c4"
  }
}
