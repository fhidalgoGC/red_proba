# ── Cloud Map · api-NN.poc.local / db-NN.poc.local ───────────────────────
#
# La zona se crea en la VPC de C3 y se ASOCIA tambien a la de ORQ, para que
# el orquestador resuelva api-NN.poc.local sin montar un balanceador.

resource "aws_service_discovery_private_dns_namespace" "poc" {
  name        = var.namespace
  vpc         = aws_vpc.esta["c3"].id
  description = "Descubrimiento interno de C3. Asociada tambien a ORQ."

  tags = {
    Name   = "${var.name_prefix}-ns-${var.namespace}"
    Domain = "c3"
  }
}

# La zona nace asociada solo a C3; esto la hace visible desde ORQ.
resource "aws_route53_zone_association" "orq" {
  zone_id = aws_service_discovery_private_dns_namespace.poc.hosted_zone
  vpc_id  = aws_vpc.esta["orq"].id
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
