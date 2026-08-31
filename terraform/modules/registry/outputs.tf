output "urls" { value = { for k, v in aws_ecr_repository.esta : k => v.repository_url } }
output "arns" { value = { for k, v in aws_ecr_repository.esta : k => v.arn } }
