# Politicas de identidad de los task roles — solo KMS.
#
# Las de SQS viven en el modulo messaging, que es el que conoce el ARN de
# la cola. Ponerlas aca creaba un ciclo: security -> messaging -> security.
#
# Nota: las key policies de KMS ya restringen por si solas. Estas politicas
# son la otra mitad — AWS exige que AMBAS permitan la accion. El Deny
# explicito de la key policy sigue siendo lo que hace el invariante
# inviolable: gana aunque alguien afloje esto.

data "aws_iam_policy_document" "c3" {
  statement {
    sid       = "Firmar"
    actions   = ["kms:Sign", "kms:GetPublicKey", "kms:DescribeKey"]
    resources = [aws_kms_key.firma.arn]
  }

  statement {
    sid       = "PseudonimizarTenant"
    actions   = ["kms:GenerateMac", "kms:VerifyMac"]
    resources = [aws_kms_key.hmac.arn]
  }

  # GenerateDataKey, NO Decrypt. C3 cifra y no puede leer lo que mando.
  statement {
    sid       = "CifrarMensajes"
    actions   = ["kms:GenerateDataKey", "kms:DescribeKey"]
    resources = [aws_kms_key.mensajes.arn, aws_kms_key.cola.arn]
  }
}

resource "aws_iam_role_policy" "c3_kms" {
  name   = "c3-kms"
  role   = aws_iam_role.c3_task.id
  policy = data.aws_iam_policy_document.c3.json
}

data "aws_iam_policy_document" "c4" {
  # Decrypt, NO Sign. La accion ni siquiera aparece.
  statement {
    sid       = "DescifrarMensajes"
    actions   = ["kms:Decrypt", "kms:DescribeKey"]
    resources = [aws_kms_key.mensajes.arn, aws_kms_key.cola.arn]
  }

  # Solo la publica, para verificar firmas. Nunca Sign.
  statement {
    sid       = "LeerPublicaParaVerificar"
    actions   = ["kms:GetPublicKey", "kms:DescribeKey"]
    resources = [aws_kms_key.firma.arn]
  }
}

resource "aws_iam_role_policy" "c4_kms" {
  name   = "c4-kms"
  role   = aws_iam_role.c4_task.id
  policy = data.aws_iam_policy_document.c4.json
}

# El orquestador no recibe politica de identidad: solo habla HTTP con C3.
# Su execution role alcanza para hacer pull de ECR y escribir logs.
