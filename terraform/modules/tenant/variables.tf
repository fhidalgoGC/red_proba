variable "name_prefix" { type = string }
variable "tenants" { type = list(string) }

variable "cluster_arn" { type = string }
variable "subnets_app" { type = list(string) }
variable "subnets_datos" { type = list(string) }
variable "sg_tenant_ids" { type = map(string) }
variable "namespace_id" { type = string }
variable "namespace_nombre" { type = string }

variable "rol_ejecucion_arn" { type = string }
variable "rol_task_arn" { type = string }

variable "imagen_api" { type = string }

# ── Base de datos · RDS ───────────────────────────────────────────────────
variable "db_password_secret_arn" {
  type        = string
  description = "Secreto que lee el contenedor del API para conectarse."
}

variable "db_password" {
  type        = string
  sensitive   = true
  description = "Contrasena maestra de RDS. La genera el root module."
}

variable "db_subnet_group" {
  type        = string
  description = "DB subnet group de C3. RDS lo exige abarcando >=2 AZ."
}

variable "rds_activo" {
  type        = bool
  description = <<-D
    RDS no escala a cero: la unica forma de no pagarlo es destruirlo. Por
    eso sigue la perilla de encendido, igual que los interface endpoints.
    ⚠ Con false, apagar BORRA LA BASE.
  D
}

variable "rds_instance_class" { type = string }
variable "rds_engine_version" { type = string }
variable "rds_storage_gb" { type = number }

# ── KMS y cola ────────────────────────────────────────────────────────────
variable "kms_firma_arn" { type = string }
variable "kms_hmac_arn" { type = string }
variable "kms_mensajes_arn" { type = string }
variable "cola_url" { type = string }

variable "desired_count" {
  type        = number
  description = <<-D
    T-07 · La perilla de apagado. Con 0, Terraform crea las task
    definitions y los services pero ninguna tarea arranca, asi que
    tampoco intenta hacer pull de una imagen que quiza no existe.
  D
  default     = 0
}

variable "log_retention_days" {
  type    = number
  default = 1
}

variable "acceso_externo" {
  type        = bool
  description = "IP publica en la task y endpoint publico en RDS. Ver modules/network/acceso-externo.tf."
  default     = false
}
