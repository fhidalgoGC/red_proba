output "id" {
  description = "Instance id. Es el --target de aws ssm start-session."
  value       = aws_instance.esta.id
}

output "ip_privada" { value = aws_instance.esta.private_ip }
