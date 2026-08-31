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

variable "acceso_externo" {
  type        = bool
  description = "IP publica en la task y endpoint publico en RDS. Ver modules/network/acceso-externo.tf."
  default     = false
}

variable "concurrencia" {
  type        = number
  description = <<-D
    Lazos de recepcion concurrentes dentro de cada task de C4.

    Con 1 -el defecto- el consumidor se comporta como antes de que esto
    existiera: ~200 msg/s por task, con la CPU ociosa 40 de cada 50 ms
    esperando a SQS.

    El pool de Postgres se dimensiona a partir de aqui (`concurrencia × 10`),
    porque cada grupo del lote abre su propia transaccion.
  D
  default     = 1

  validation {
    condition     = var.concurrencia >= 1 && var.concurrencia <= 64
    error_message = "Entre 1 y 64. Por encima el cuello es la base, no el consumidor."
  }
}

variable "lote_transaccion" {
  type        = bool
  description = <<-D
    Persistir el lote entero en UNA transaccion.

    ⚠ CAMBIA LO QUE MIDE P1. Los N eventos comparten COMMIT, asi que comparten
      `e10`: el tramo e9→e10 pasa a medir el lote y no el evento.

    Apagado por defecto para que la medicion siga significando lo mismo salvo
    que alguien decida lo contrario a proposito.
  D
  default     = false
}
