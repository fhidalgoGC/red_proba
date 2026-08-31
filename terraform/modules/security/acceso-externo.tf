# ── ACCESO EXTERNO · un bastion por VPC, y nada expuesto ─────────────────
#
# La puerta para llegar desde tu maquina a los endpoints y a las bases. Por
# defecto NO EXISTE: `acceso_externo = false` y aqui no se crea nada.
#
# ── Por que un bastion y no IP publicas ─────────────────────────────────────
#
# Porque el coste de las IP publicas crece con los tenants y el del bastion no:
#
#              1 tenant     50 tenants
#   IP publica  $0,60/dia   $12,36/dia   (50 tasks + 50 RDS + ORQ + C4 + su RDS)
#   Bastion     $0,48/dia   $0,48/dia
#
# Y los 50 tenants viven en la MISMA VPC de C3, asi que UN bastion alcanza las
# 50 tasks y las 50 RDS. Lo unico que crece son estas reglas de security group,
# que son gratis.
#
# ── Por que DOS bastiones ───────────────────────────────────────────────────
#
# Uno por VPC, y no es una eleccion: la RDS de C4 vive en la VPC de C4 y NO HAY
# RUTA entre C3 y C4. Un bastion en C3 no la alcanza — y eso es exactamente el
# invariante que la PoC demuestra, no un obstaculo a rodear.
#
# ── Que expone ──────────────────────────────────────────────────────────────
#
# Nada. El bastion NO TIENE NINGUNA REGLA DE ENTRADA: se entra por Session
# Manager, que es una sesion SALIENTE del agente hacia SSM. No hay puerto
# abierto que escanear, no hay llave SSH que rotar, y lo que autoriza es IAM.
#
# Las tasks siguen con `assign_public_ip = false` y las RDS con
# `publicly_accessible = false`. Lo unico con IP publica es el bastion, y solo
# para que su agente alcance SSM sin pagar tres interface endpoints por VPC.

locals {
  # Las dos VPC, solo si la perilla esta encendida.
  _bastiones = var.acceso_externo ? var.vpc_ids : {}

  # Puerto × tenant, aplanado. Con 50 tenants son 100 reglas y da igual: cada
  # security group de tenant recibe 2, muy por debajo del limite de 60.
  _tenant_puertos = var.acceso_externo ? {
    for par in setproduct(var.tenants, [8080, 5432]) :
    "${par[0]}-${par[1]}" => { tenant = par[0], puerto = par[1] }
  } : {}

  _c4_puertos = var.acceso_externo ? { for p in [3003, 5432] : tostring(p) => p } : {}
}

# ── El security group del bastion ────────────────────────────────────────
resource "aws_security_group" "bastion" {
  for_each = local._bastiones

  name        = "${var.name_prefix}-sg-bastion-${each.key}"
  vpc_id      = each.value
  description = "Bastion de ${each.key}. SIN reglas de entrada: se entra por Session Manager."

  tags = {
    Name   = "${var.name_prefix}-sg-bastion-${each.key}"
    Domain = each.key
    Nota   = "acceso_externo=true - temporal"
  }
}

# SIN ingress, a proposito. No es un descuido que haya que "completar despues":
# es lo que hace que este host no tenga superficie de ataque. Los security
# groups son stateful, asi que las respuestas del tunel fluyen igual.

resource "aws_vpc_security_group_egress_rule" "bastion_https" {
  for_each = local._bastiones

  security_group_id = aws_security_group.bastion[each.key].id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  description       = "HTTPS hacia SSM - sin esto el agente no registra y no hay sesion"
}

# Hacia dentro de su propia VPC, cualquier puerto: es el punto del bastion.
# Acotarlo a 8080/5432/9090/3003 obligaria a tocar Terraform cada vez que se
# quiera mirar un puerto nuevo, y no compra nada — quien llegue aqui ya tiene
# credenciales de la cuenta.
resource "aws_vpc_security_group_egress_rule" "bastion_vpc" {
  for_each = local._bastiones

  security_group_id = aws_security_group.bastion[each.key].id
  cidr_ipv4         = var.vpc_cidrs[each.key]
  from_port         = 1
  to_port           = 65535
  ip_protocol       = "tcp"
  description       = "Hacia los servicios y las bases de su propia VPC"
}

# ── Lo que el bastion puede alcanzar ─────────────────────────────────────
#
# Origen = el grupo del bastion, NO un CIDR. Si el bastion cambia de subnet o
# de IP, estas reglas siguen valiendo.

resource "aws_vpc_security_group_ingress_rule" "tenant_desde_bastion" {
  for_each = local._tenant_puertos

  security_group_id            = aws_security_group.tenant[each.value.tenant].id
  referenced_security_group_id = aws_security_group.bastion["c3"].id
  from_port                    = each.value.puerto
  to_port                      = each.value.puerto
  ip_protocol                  = "tcp"
  description                  = "TEMPORAL - ${each.value.puerto == 8080 ? "API de C3" : "Postgres del tenant"} desde el bastion"
}

resource "aws_vpc_security_group_ingress_rule" "c4_desde_bastion" {
  for_each = local._c4_puertos

  security_group_id            = aws_security_group.c4.id
  referenced_security_group_id = aws_security_group.bastion["c4"].id
  from_port                    = each.value
  to_port                      = each.value
  ip_protocol                  = "tcp"
  description                  = "TEMPORAL - ${each.value == 3003 ? "health de C4" : "Postgres de C4"} desde el bastion"
}

# ⚠ ESTA ES LA QUE MAS SE SALE DEL DISENO.
#
# `sg-orq` no tiene NINGUNA regla de entrada a proposito: es lo que garantiza
# que C3 no pueda iniciar nada hacia el arnes, y lo que recupera la
# unidireccionalidad que daba PrivateLink sin montar un NLB.
#
# Con esto, el bastion si puede — para lanzar corridas con curl en vez de por
# ECS Exec. C3 sigue sin poder: el origen es el grupo del bastion, no la VPC.
resource "aws_vpc_security_group_ingress_rule" "orq_desde_bastion" {
  for_each = var.acceso_externo ? { c3 = true } : {}

  security_group_id            = aws_security_group.orq.id
  referenced_security_group_id = aws_security_group.bastion["c3"].id
  from_port                    = 9090
  to_port                      = 9090
  ip_protocol                  = "tcp"
  description                  = "TEMPORAL - POST /batch desde el bastion"
}
