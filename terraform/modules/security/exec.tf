# ── ECS Exec · la unica puerta de entrada a la PoC ───────────────────────
#
# No hay IGW, ni NAT, ni balanceador, ni bastion. Eso es deliberado (D-03) y
# tiene una consecuencia que hay que resolver: SIN ESTO NO SE PUEDE LANZAR UNA
# CORRIDA. El `POST /batch` del orquestador escucha en una subnet privada, y la
# unica forma de alcanzarlo desde fuera seria abrir una ruta — justo lo que la
# arquitectura promete que no existe.
#
# ECS Exec no abre ninguna. Es una sesion SALIENTE del agente hacia
# ssmmessages, por el interface endpoint de la propia VPC: no hay puerto que
# escuche, no hay regla de entrada en ningun security group, y quien no pueda
# asumir credenciales de esta cuenta no llega. Lo que la autoriza es IAM, no la
# red.
#
# Y no toca el invariante: esto da una shell dentro del contenedor, con el
# mismo task role que ya tenia el proceso. El rol de C4 sigue sin kms:Sign y la
# key policy de la llave Ed25519 se lo sigue negando. Una shell en C4 no puede
# firmar nada.
#
# ⚠ Es la puerta de servicio de la PoC. Si esto fuera producto, iria detras de
#   una condicion de sesion y un registro de auditoria — no suelto en el rol.

data "aws_iam_policy_document" "exec" {
  statement {
    sid = "CanalDeSesion"
    actions = [
      "ssmmessages:CreateControlChannel",
      "ssmmessages:CreateDataChannel",
      "ssmmessages:OpenControlChannel",
      "ssmmessages:OpenDataChannel",
    ]
    # ssmmessages no tiene recursos que nombrar: el permiso es sobre el canal,
    # y a quien deja entrar lo decide de que task se trata, no un ARN.
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "exec" {
  for_each = {
    c3  = aws_iam_role.c3_task.id
    c4  = aws_iam_role.c4_task.id
    orq = aws_iam_role.orq_task.id
  }

  name   = "ecs-exec"
  role   = each.value
  policy = data.aws_iam_policy_document.exec.json
}
