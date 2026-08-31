# ── D-04 · Las llaves de firma viven en C3 y C4 no puede usarlas ─────────
#
# ⚠ DESVIACION DOCUMENTADA: el diseno pide dos cuentas (c3-dev, c4-dev) en
#   OUs separadas. Esta PoC corre en UNA sola cuenta, porque es la unica
#   disponible. Consecuencia: el invariante ya no se apoya en la frontera
#   de cuenta, solo en estas key policies.
#
#   Lo que lo mantiene real: un Deny EXPLICITO en la key policy gana sobre
#   cualquier Allow de IAM, incluso de un admin. No es una convencion de
#   codigo — el rol de C4 no puede firmar aunque alguien le adjunte una
#   politica permisiva.
#
#   Lo que se pierde: un admin de la cuenta puede EDITAR la key policy.
#   Con dos cuentas no podria. Eso hay que decirlo en la demo.

data "aws_caller_identity" "actual" {}

locals {
  cuenta   = data.aws_caller_identity.actual.account_id
  raiz_arn = "arn:aws:iam::${local.cuenta}:root"
}

# Permite que IAM gobierne la llave. Sin esto la llave queda huerfana y
# solo se recupera por soporte de AWS.
data "aws_iam_policy_document" "kms_base" {
  statement {
    sid       = "HabilitarIAM"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = [local.raiz_arn]
    }
  }
}

# ── 1. Llave de firma Ed25519 · vive en C3 ───────────────────────────────
#
# KMS SI soporta Ed25519: key spec ECC_NIST_EDWARDS25519, algoritmo
# ED25519_SHA_512 con MessageType RAW.
#
# ⚠ RAW acepta mensajes de 0-4096 bytes. El payload canonico son 3072 →
#   entra con 1024 de margen. Si alguien sube el target por encima de 4096,
#   RAW deja de funcionar y hay que pasar a ED25519_PH_SHA_512 con digest.
#   Los dos MessageType NO son intercambiables: C3 y C4 deben coincidir.

data "aws_iam_policy_document" "firma" {
  source_policy_documents = [data.aws_iam_policy_document.kms_base.json]

  statement {
    sid       = "C3Firma"
    actions   = ["kms:Sign", "kms:GetPublicKey", "kms:DescribeKey"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = [aws_iam_role.c3_task.arn]
    }
  }

  # C4 puede LEER la publica para verificar, y nada mas.
  statement {
    sid       = "C4SoloVerifica"
    actions   = ["kms:GetPublicKey", "kms:DescribeKey"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = [aws_iam_role.c4_task.arn]
    }
  }

  # ── EL INVARIANTE ──
  # Deny explicito. Gana sobre cualquier Allow de IAM.
  statement {
    sid       = "C4NuncaFirma"
    effect    = "Deny"
    actions   = ["kms:Sign"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = [aws_iam_role.c4_task.arn, aws_iam_role.orq_task.arn]
    }
  }
}

resource "aws_kms_key" "firma" {
  description              = "${var.name_prefix} · Ed25519 de firma · C3 firma, C4 NUNCA"
  key_usage                = "SIGN_VERIFY"
  customer_master_key_spec = "ECC_NIST_EDWARDS25519"
  deletion_window_in_days  = 7
  policy                   = data.aws_iam_policy_document.firma.json

  tags = { Name = "${var.name_prefix}-kms-firma", Domain = "c3", Track = "T" }
}

resource "aws_kms_alias" "firma" {
  name          = "alias/${var.name_prefix}-firma"
  target_key_id = aws_kms_key.firma.key_id
}

# ── 2. Llave HMAC de pseudonimizacion · vive en C3 ───────────────────────
#
# El rpf_id viaja en claro (FIFO lo necesita para agrupar). No es contenido
# fiscal, pero revela que expedientes estan activos — por eso el id de
# tenant que va DENTRO del payload va pseudonimizado con HMAC.

data "aws_iam_policy_document" "hmac" {
  source_policy_documents = [data.aws_iam_policy_document.kms_base.json]

  statement {
    sid       = "C3GeneraMac"
    actions   = ["kms:GenerateMac", "kms:VerifyMac", "kms:DescribeKey"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = [aws_iam_role.c3_task.arn]
    }
  }

  statement {
    sid       = "C4NuncaPseudonimiza"
    effect    = "Deny"
    actions   = ["kms:GenerateMac", "kms:VerifyMac"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = [aws_iam_role.c4_task.arn]
    }
  }
}

resource "aws_kms_key" "hmac" {
  description              = "${var.name_prefix} · HMAC de pseudonimizacion de tenant · solo C3"
  key_usage                = "GENERATE_VERIFY_MAC"
  customer_master_key_spec = "HMAC_256"
  deletion_window_in_days  = 7
  policy                   = data.aws_iam_policy_document.hmac.json

  tags = { Name = "${var.name_prefix}-kms-hmac", Domain = "c3", Track = "T" }
}

resource "aws_kms_alias" "hmac" {
  name          = "alias/${var.name_prefix}-hmac"
  target_key_id = aws_kms_key.hmac.key_id
}

# ── 3. Llave simetrica de cifrado de mensajes · vive en C4 ───────────────
#
# La asimetria es el invariante:
#   C3 -> GenerateDataKey  (cifra, NO puede descifrar)
#   C4 -> Decrypt          (descifra, NO puede firmar)

data "aws_iam_policy_document" "mensajes" {
  source_policy_documents = [data.aws_iam_policy_document.kms_base.json]

  statement {
    sid       = "C3SoloCifra"
    actions   = ["kms:GenerateDataKey", "kms:DescribeKey"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = [aws_iam_role.c3_task.arn]
    }
  }

  statement {
    sid       = "C4SoloDescifra"
    actions   = ["kms:Decrypt", "kms:DescribeKey"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = [aws_iam_role.c4_task.arn]
    }
  }

  # C3 cifra pero no descifra. Si pudiera, podria leer lo que manda al
  # operador neutro y el canal dejaria de ser unidireccional.
  statement {
    sid       = "C3NuncaDescifra"
    effect    = "Deny"
    actions   = ["kms:Decrypt"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = [aws_iam_role.c3_task.arn]
    }
  }
}

resource "aws_kms_key" "mensajes" {
  description             = "${var.name_prefix} · simetrica de mensajes · C3 cifra, C4 descifra"
  deletion_window_in_days = 7
  policy                  = data.aws_iam_policy_document.mensajes.json

  tags = { Name = "${var.name_prefix}-kms-mensajes", Domain = "c4", Track = "T" }
}

resource "aws_kms_alias" "mensajes" {
  name          = "alias/${var.name_prefix}-mensajes"
  target_key_id = aws_kms_key.mensajes.key_id
}

# ── 4. Llave de cifrado de la cola en reposo · vive en C4 ────────────────

data "aws_iam_policy_document" "cola" {
  source_policy_documents = [data.aws_iam_policy_document.kms_base.json]

  statement {
    sid       = "ProductorYConsumidor"
    actions   = ["kms:GenerateDataKey", "kms:Decrypt", "kms:DescribeKey"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = [aws_iam_role.c3_task.arn, aws_iam_role.c4_task.arn]
    }
  }

  statement {
    sid       = "SQSUsaLaLlave"
    actions   = ["kms:GenerateDataKey", "kms:Decrypt"]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["sqs.amazonaws.com"]
    }
  }
}

resource "aws_kms_key" "cola" {
  description             = "${var.name_prefix} · cifrado en reposo de la cola FIFO"
  deletion_window_in_days = 7
  policy                  = data.aws_iam_policy_document.cola.json

  tags = { Name = "${var.name_prefix}-kms-cola", Domain = "c4", Track = "T" }
}

resource "aws_kms_alias" "cola" {
  name          = "alias/${var.name_prefix}-cola"
  target_key_id = aws_kms_key.cola.key_id
}
