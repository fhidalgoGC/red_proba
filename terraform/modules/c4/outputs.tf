output "db_endpoint" {
  description = "Endpoint de RDS de C4. Vacio cuando rds_activo=false."
  value       = try(aws_db_instance.esta[0].address, "")
}
