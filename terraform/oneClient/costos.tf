# ══════════════════════════════════════════════════════════════════════════
#  Guardas de costo — en Terraform, no en un script que alguien recuerde.
# ══════════════════════════════════════════════════════════════════════════

# ── Presupuesto con alerta ────────────────────────────────────────────────
#
# El baseline de la cuenta es ~$0,0811/dia (~$2,45/mes), plano. Cualquier
# cosa por encima del umbral es nuestra y es una PoC que se quedo prendida.
#
# ⚠ El filtro por tag NO se usa aca a proposito: filtrar un budget por
#   TagKeyValue exige que la cost allocation tag este ACTIVADA, y esta
#   cuenta es miembro de una org — solo el payer 324005485665 puede
#   activarla. Un budget a nivel cuenta funciona hoy, sin depender de
#   nadie, y con este baseline es senal suficiente.

resource "aws_budgets_budget" "poc" {
  name         = "${var.name_prefix}-presupuesto"
  budget_type  = "COST"
  limit_amount = var.presupuesto_mensual_usd
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  # 50% avisa temprano; 80% es "anda a apagarlo"; 100% ya se paso.
  dynamic "notification" {
    for_each = [50, 80, 100]
    content {
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value
      threshold_type             = "PERCENTAGE"
      notification_type          = "ACTUAL"
      subscriber_email_addresses = [var.owner]
    }
  }

  # Proyeccion: avisa ANTES de gastarlo, que es cuando todavia sirve.
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.owner]
  }
}

# ── Bucket de exportacion ─────────────────────────────────────────────────
#
# ⚠ Los log groups SE VAN CON EL DESTROY Y NO SE RECUPERAN. La exportacion
#   tiene que ocurrir ANTES. Sin este bucket creado de antemano, el dia del
#   destroy no hay donde poner nada.
#
# Tambien es el destino de las tablas de medicion (M-03): outbox de C3 e
# inbox de C4 se vuelcan aca y todo el analisis se hace despues con SQL.

resource "random_id" "sufijo" {
  byte_length = 4
}

resource "aws_s3_bucket" "exportacion" {
  bucket = "${var.name_prefix}-exportacion-${random_id.sufijo.hex}"

  # Es una PoC: que el destroy se lleve todo en vez de fallar por objetos.
  force_destroy = true

  tags = { Domain = "shared", Track = "T" }
}

resource "aws_s3_bucket_public_access_block" "exportacion" {
  bucket                  = aws_s3_bucket.exportacion.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "exportacion" {
  bucket = aws_s3_bucket.exportacion.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

# Que los datos de una corrida no queden facturando para siempre.
resource "aws_s3_bucket_lifecycle_configuration" "exportacion" {
  bucket = aws_s3_bucket.exportacion.id
  rule {
    id     = "expirar"
    status = "Enabled"
    filter {}
    expiration { days = var.exportacion_retencion_dias }
  }
}

# CloudWatch Logs necesita permiso explicito para escribir el export.
data "aws_iam_policy_document" "exportacion" {
  statement {
    sid    = "LogsExportaAca"
    effect = "Allow"
    principals {
      type        = "Service"
      identifiers = ["logs.${var.region}.amazonaws.com"]
    }
    actions   = ["s3:GetBucketAcl"]
    resources = [aws_s3_bucket.exportacion.arn]
  }

  statement {
    sid    = "LogsEscribeObjetos"
    effect = "Allow"
    principals {
      type        = "Service"
      identifiers = ["logs.${var.region}.amazonaws.com"]
    }
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.exportacion.arn}/*"]
    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-acl"
      values   = ["bucket-owner-full-control"]
    }
  }
}

resource "aws_s3_bucket_policy" "exportacion" {
  bucket = aws_s3_bucket.exportacion.id
  policy = data.aws_iam_policy_document.exportacion.json
}
