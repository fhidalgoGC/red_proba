variable "name_prefix" { type = string }
variable "cluster_arn" { type = string }
variable "subnets_app" { type = list(string) }
variable "subnets_datos" { type = list(string) }
variable "sg_id" { type = string }

variable "rol_ejecucion_arn" { type = string }
variable "rol_task_arn" { type = string }

variable "imagen_consumer" { type = string }

# ── Base de datos · RDS ───────────────────────────────────────────────────
variable "db_password_secret_arn" { type = string }

variable "db_password" {
  type      = string
  sensitive = true
}

variable "db_subnet_group" {
  type        = string
  description = "DB subnet group de C4. RDS lo exige abarcando >=2 AZ."
}

variable "rds_activo" {
  type        = bool
  description = "⚠ Con false, apagar BORRA la base del inbox."
}

variable "rds_instance_class" { type = string }
variable "rds_engine_version" { type = string }
variable "rds_storage_gb" { type = number }

# ── KMS y cola ────────────────────────────────────────────────────────────
variable "kms_firma_arn" { type = string }
variable "kms_mensajes_arn" { type = string }
variable "cola_url" { type = string }
variable "dlq_url" { type = string }

variable "desired_count" {
  type    = number
  default = 0
}

variable "log_retention_days" {
  type    = number
  default = 1
}
