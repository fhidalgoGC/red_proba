variable "name_prefix" { type = string }
variable "tenants" {
  type        = list(string)
  description = "Lista de tenants. oneClient: [\"01\"]. 50client: [\"01\"..\"50\"]."
}
variable "vpc_ids" { type = map(string) }
variable "vpc_cidrs" { type = map(string) }

variable "acceso_externo" {
  type        = bool
  description = <<-D
    Crear el security group del bastion y las reglas que le dejan alcanzar los
    servicios y las bases. Ver acceso-externo.tf.

    NO hace falta ningun CIDR: el bastion no tiene reglas de entrada. Se entra
    por Session Manager, que es una sesion saliente autorizada por IAM.
  D
  default     = false
}
