variable "name_prefix" { type = string }
variable "cluster_arn" { type = string }
variable "subnets_app" { type = list(string) }
variable "sg_id" { type = string }
variable "rol_ejecucion_arn" { type = string }
variable "rol_task_arn" { type = string }
variable "imagen_driver" { type = string }
variable "api_hosts" { type = map(string) }
variable "desired_count" {
  type    = number
  default = 0
}
variable "log_retention_days" {
  type    = number
  default = 1
}
variable "namespace_id" {
  type        = string
  description = <<-D
    Zona de Cloud Map de C3, la misma que usan los tenants. El orquestador se
    registra como `orq.poc.local`.

    No es cosmetico: es lo que permite que el tunel del bastion apunte a un
    NOMBRE en vez de a la IP de la task, que cambia en cada reemplazo.
  D
}

variable "acceso_externo" {
  type        = bool
  description = "Sin efecto en este modulo desde que el acceso va por bastion. Se conserva para no romper llamadas existentes."
  default     = false
}
