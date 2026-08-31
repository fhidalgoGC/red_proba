# ── D-03 · SQS FIFO es el UNICO canal entre C3 y C4 ──────────────────────
#
# Sin peering, sin Transit Gateway, sin PrivateLink entre las dos VPC. Cada
# una alcanza SQS por su propio endpoint.
#
# Con peering, "unica ruta permitida" seria una regla que alguien puede
# modificar. Sin peering es una propiedad de la topologia: no hay camino
# que aflojar. Eso es lo que se puede afirmar ante una auditoria.

resource "aws_sqs_queue" "dlq" {
  name       = "${var.name_prefix}-eventos-dlq.fifo"
  fifo_queue = true

  # La DLQ hereda la misma configuracion de dedup que la principal:
  # un mensaje que cae aca conserva su MessageDeduplicationId.
  deduplication_scope         = "messageGroup"
  fifo_throughput_limit       = "perMessageGroupId"
  content_based_deduplication = false

  kms_master_key_id                 = var.kms_cola_arn
  kms_data_key_reuse_period_seconds = 300

  message_retention_seconds = 1209600 # 14 dias, el maximo

  tags = { Name = "${var.name_prefix}-eventos-dlq", Domain = "c4", Track = "T" }
}

resource "aws_sqs_queue" "eventos" {
  name       = "${var.name_prefix}-eventos.fifo"
  fifo_queue = true

  # ── Alto rendimiento ──
  # No cuesta nada y sube el techo: 300 msg/s POR GRUPO en vez de 300 para
  # toda la cola. Obliga a que el alcance de dedup sea por grupo, lo cual
  # aca no molesta: un duplicado del mismo evento comparte rpf_id y
  # dedup_id, cae en el mismo grupo y se detecta igual.
  deduplication_scope   = "messageGroup"
  fifo_throughput_limit = "perMessageGroupId"

  # ── D-11 · Dedup por CONTENIDO DESACTIVADA ──
  # AES-GCM usa un IV distinto en cada operacion: el mismo evento cifrado
  # dos veces produce ciphertext distinto. Si SQS hasheara el mensaje nunca
  # detectaria un duplicado. El MessageDeduplicationId lo calcula C3 sobre
  # el texto EN CLARO y lo pasa explicito.
  content_based_deduplication = false

  kms_master_key_id                 = var.kms_cola_arn
  kms_data_key_reuse_period_seconds = 300

  # Ventana de visibilidad. Debe superar lo que tarda C4 en descifrar,
  # verificar y persistir; si no, el mensaje reaparece mientras se procesa
  # y se dispara trabajo duplicado (que el inbox absorbe, pero cuesta).
  visibility_timeout_seconds = 60
  receive_wait_time_seconds  = 20 # long polling (G-01)
  message_retention_seconds  = 345600

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq.arn
    maxReceiveCount     = var.max_receive_count
  })

  tags = { Name = "${var.name_prefix}-eventos", Domain = "c4", Track = "T" }
}

# ── Resource policy de la cola · "SE OLVIDA SIEMPRE" ─────────────────────
#
# En el diseno de dos cuentas esto es cross-account y es obligatorio. Aca
# es la misma cuenta, asi que tecnicamente la politica de identidad de C3
# bastaria — pero la dejamos explicita para que el dia que se separen las
# cuentas no haya que descubrirla.
#
# Cuando falta, el error es AccessDenied y NO distingue si falta la policy
# de la cola o el permiso de KMS.

data "aws_iam_policy_document" "cola" {
  statement {
    sid    = "C3Publica"
    effect = "Allow"
    principals {
      type        = "AWS"
      identifiers = [var.rol_c3_arn]
    }
    # ⚠ La RESOURCE POLICY de SQS solo admite una lista corta de acciones,
    #   y las variantes *Batch NO estan en ella: SetQueueAttributes rechaza
    #   "sqs:SendMessageBatch" con InvalidParameterValue.
    #   SendMessage ya cubre SendMessageBatch en la resource policy.
    #
    #   No confundir con las politicas de IDENTIDAD (policies.tf), que si
    #   aceptan las *Batch. Son dos lenguajes distintos para el mismo
    #   servicio.
    actions   = ["sqs:SendMessage", "sqs:GetQueueAttributes", "sqs:GetQueueUrl"]
    resources = [aws_sqs_queue.eventos.arn]
  }
}

resource "aws_sqs_queue_policy" "eventos" {
  count = var.permisos_de_task ? 1 : 0

  queue_url = aws_sqs_queue.eventos.id
  policy    = data.aws_iam_policy_document.cola.json
}
