# Politicas de SQS de los task roles.
#
# Viven aca y no en el modulo security porque este modulo es el que conoce
# el ARN de la cola. Al reves habria ciclo.

data "aws_iam_policy_document" "c3_sqs" {
  statement {
    sid       = "PublicarEnLaCola"
    actions   = ["sqs:SendMessage", "sqs:SendMessageBatch", "sqs:GetQueueUrl", "sqs:GetQueueAttributes"]
    resources = [aws_sqs_queue.eventos.arn]
  }
}

resource "aws_iam_role_policy" "c3_sqs" {
  name   = "c3-sqs"
  role   = var.rol_c3_id
  policy = data.aws_iam_policy_document.c3_sqs.json
}

data "aws_iam_policy_document" "c4_sqs" {
  statement {
    sid = "ConsumirLaCola"
    actions = [
      "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:DeleteMessageBatch",
      "sqs:GetQueueUrl", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility",
    ]
    resources = [aws_sqs_queue.eventos.arn, aws_sqs_queue.dlq.arn]
  }

  # G-07: lo que no descifra o no verifica va a la DLQ, no al reintento.
  statement {
    sid       = "MandarALaDLQ"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.dlq.arn]
  }
}

resource "aws_iam_role_policy" "c4_sqs" {
  name   = "c4-sqs"
  role   = var.rol_c4_id
  policy = data.aws_iam_policy_document.c4_sqs.json
}
