output "api_hosts" {
  description = "Nombres DNS que resuelve el orquestador por Cloud Map."
  value       = { for t in var.tenants : t => "api-${t}.${var.namespace_nombre}" }
}

output "db_endpoints" {
  description = "Endpoints de RDS por tenant. Vacio cuando rds_activo=false."
  value       = { for k, v in aws_db_instance.esta : k => v.address }
}
