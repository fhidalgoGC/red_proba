# ── ECR ──────────────────────────────────────────────────────────────────
#
# D-07: UNA imagen sirve a los 50 tenants. 50 imagenes serian 50 cosas que
# pueden divergir.
#
# force_delete: sin esto el destroy falla si el repo tiene imagenes, y hay
# que vaciarlo a mano. Es una PoC — que se vaya con todo.

resource "aws_ecr_repository" "esta" {
  for_each = toset(var.repos)

  name                 = "${var.name_prefix}-${each.key}"
  image_tag_mutability = "MUTABLE"
  force_delete         = true

  image_scanning_configuration { scan_on_push = false }

  tags = { Name = "${var.name_prefix}-${each.key}", Domain = "shared", Track = "T" }
}

# Retener solo las ultimas 3 imagenes: el almacenamiento de ECR se cobra.
resource "aws_ecr_lifecycle_policy" "esta" {
  for_each   = aws_ecr_repository.esta
  repository = each.value.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Conservar solo las 3 ultimas"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 3 }
      action       = { type = "expire" }
    }]
  })
}
