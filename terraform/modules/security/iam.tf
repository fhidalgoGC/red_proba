# ── Roles ────────────────────────────────────────────────────────────────
#
# Dos roles por tarea, y la diferencia importa:
#   execution role -> lo usa ECS, no tu codigo. Pull de ECR, leer el
#                     secreto, escribir logs.
#   task role      -> lo usa tu proceso. KMS, SQS.

data "aws_iam_policy_document" "asume_ecs" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# ── Execution role · compartido por los tres dominios ────────────────────
resource "aws_iam_role" "ejecucion" {
  name               = "${var.name_prefix}-ecs-ejecucion"
  assume_role_policy = data.aws_iam_policy_document.asume_ecs.json
  tags               = { Domain = "shared", Track = "T" }
}

resource "aws_iam_role_policy_attachment" "ejecucion_base" {
  role       = aws_iam_role.ejecucion.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Leer los secretos de Postgres y descifrarlos.
data "aws_iam_policy_document" "ejecucion_secretos" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = ["arn:aws:secretsmanager:*:${local.cuenta}:secret:${var.name_prefix}-*"]
  }
}

resource "aws_iam_role_policy" "ejecucion_secretos" {
  name   = "secretos"
  role   = aws_iam_role.ejecucion.id
  policy = data.aws_iam_policy_document.ejecucion_secretos.json
}

# ── Task role de C3 ──────────────────────────────────────────────────────
# Firma, pseudonimiza, cifra y publica. NO descifra.
resource "aws_iam_role" "c3_task" {
  name               = "${var.name_prefix}-c3-task"
  assume_role_policy = data.aws_iam_policy_document.asume_ecs.json
  tags               = { Domain = "c3", Track = "C" }
}

# ── Task role de C4 ──────────────────────────────────────────────────────
# Descifra, verifica y persiste. NUNCA firma.
resource "aws_iam_role" "c4_task" {
  name               = "${var.name_prefix}-c4-task"
  assume_role_policy = data.aws_iam_policy_document.asume_ecs.json
  tags               = { Domain = "c4", Track = "G" }
}

# ── Task role del orquestador ────────────────────────────────────────────
# Solo habla HTTP con los API de C3. No toca KMS ni SQS ni C4.
resource "aws_iam_role" "orq_task" {
  name               = "${var.name_prefix}-orq-task"
  assume_role_policy = data.aws_iam_policy_document.asume_ecs.json
  tags               = { Domain = "orq", Track = "O" }
}

# Las politicas de KMS/SQS se adjuntan en policies.tf, porque dependen de
# ARNs que se crean despues (cola) o en el mismo archivo (llaves).
