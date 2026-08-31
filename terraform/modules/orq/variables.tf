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