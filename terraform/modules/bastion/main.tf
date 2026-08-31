# ── BASTION · el punto de entrada, uno por VPC ───────────────────────────
#
# ES ANDAMIO, como el orquestador. Existe para poder probar desde fuera y
# desaparece con `--sin-acceso-externo`. Que no se cite como parte del diseno.
#
# ── Como se entra ───────────────────────────────────────────────────────────
#
# Por Session Manager. NO hay llave SSH, NO hay puerto 22, NO hay regla de
# entrada en su security group. El agente de SSM abre una sesion SALIENTE hacia
# el servicio y el tunel viaja por ahi. Lo que autoriza es IAM.
#
# Consecuencia practica: el bastion no tiene superficie que escanear. Un
# `nmap` contra su IP publica no encuentra un solo puerto abierto.
#
# ── Para que sirve de verdad: port forwarding ────────────────────────────────
#
#   aws ssm start-session --target <id> \
#     --document-name AWS-StartPortForwardingSessionToRemoteHost \
#     --parameters '{"host":["api-01.poc.local"],"portNumber":["8080"],
#                    "localPortNumber":["18001"]}'
#
# El `host` lo resuelve el BASTION, no tu maquina. Por eso funcionan los
# nombres de Cloud Map (`api-01.poc.local`, `orq.poc.local`) y los endpoints de
# RDS: son privados, y el bastion esta dentro. Desde tu portatil es
# `localhost:18001`, y ahi valen curl, Postman, psql, DBeaver o TablePlus.
#
# ── Por que escala a 50 tenants y las IP publicas no ────────────────────────
#
# Los 50 tenants estan en la MISMA VPC. Un bastion los alcanza todos, y sus 50
# bases tambien. El coste es plano:
#
#                1 tenant     50 tenants
#   IP publica    $0,60/dia    $12,36/dia
#   Bastion       $0,24/dia    $0,24/dia    (por VPC)
#
# ── Por que tiene IP publica ─────────────────────────────────────────────────
#
# Solo para que su agente alcance SSM. La alternativa es tres interface
# endpoints por VPC (`ssm`, `ssmmessages`, `ec2messages`) a $0,24/dia cada uno:
# $0,72/dia por VPC contra $0,12 de la IP. Seis veces mas caro para no ganar
# nada — la IP no abre nada, porque no hay ingress.
#
# Si algun dia el requisito es "cero IP publicas en la cuenta", se cambia por
# los endpoints y el resto del modulo no se toca.

# La ultima Amazon Linux 2023 para arm64. Por SSM y no fija: un AMI id
# hardcodeado caduca y el error es "InvalidAMIID.NotFound", que no dice que la
# imagen se retiro.
data "aws_ssm_parameter" "ami" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

resource "aws_iam_role" "esta" {
  name = "${var.name_prefix}-bastion-${var.vpc}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "ec2.amazonaws.com" }
    }]
  })

  tags = { Domain = var.vpc, Track = "T", Nota = "acceso_externo - temporal" }
}

# La politica gestionada de AWS. Es la que trae los permisos de ssmmessages y
# ec2messages que el agente necesita para registrarse; escribirla a mano es
# copiar algo que AWS mantiene.
#
# ⚠ Este rol NO lleva nada mas. En particular no lleva KMS ni SQS: una shell en
#   el bastion no puede firmar, ni descifrar, ni publicar. El invariante del
#   Proof Ledger no depende de este host.
resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.esta.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "esta" {
  name = "${var.name_prefix}-bastion-${var.vpc}"
  role = aws_iam_role.esta.name
}

resource "aws_instance" "esta" {
  ami           = data.aws_ssm_parameter.ami.value
  instance_type = var.instance_type

  subnet_id              = var.subnet_id
  vpc_security_group_ids = [var.sg_id]
  iam_instance_profile   = aws_iam_instance_profile.esta.name

  # Solo para que el agente alcance SSM. No abre nada: sin ingress no hay
  # puerto que responder.
  associate_public_ip_address = true

  # IMDSv2 obligatorio. Sin esto, cualquier proceso del host puede pedir las
  # credenciales del rol con un GET sin cabeceras — que es el vector clasico de
  # SSRF contra un bastion.
  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required"
  }

  root_block_device {
    volume_type = "gp3"
    volume_size = 8
    encrypted   = true
  }

  # El cliente de Postgres, para poder mirar una base sin montar el tunel.
  # `|| true`: si el paquete cambia de nombre en una AL2023 futura, el bastion
  # tiene que arrancar igual — su trabajo es el tunel, no traer psql.
  user_data = <<-SH
    #!/bin/bash
    dnf install -y postgresql16 || dnf install -y postgresql15 || true
  SH

  # Cambiar el user_data no justifica recrear la instancia: se aplica al
  # arrancar y esto es andamio.
  user_data_replace_on_change = false

  tags = {
    Name   = "${var.name_prefix}-bastion-${var.vpc}"
    Domain = var.vpc
    Track  = "T"
    Nota   = "acceso_externo - temporal - borrar con --sin-acceso-externo"
  }
}
