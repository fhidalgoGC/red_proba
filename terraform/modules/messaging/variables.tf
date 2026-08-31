variable "name_prefix" { type = string }
variable "kms_cola_arn" { type = string }
variable "rol_c3_id" { type = string }
variable "rol_c4_id" { type = string }
variable "rol_c3_arn" { type = string }

variable "max_receive_count" {
  type        = number
  description = "Recepciones antes de mandar el mensaje a la DLQ."
  default     = 5
}
