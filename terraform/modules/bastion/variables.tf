variable "name_prefix" { type = string }

variable "vpc" {
  type        = string
  description = "Etiqueta de la VPC: c3 o c4. Nombra el rol, el perfil y la instancia."
}

variable "subnet_id" {
  type        = string
  description = <<-D
    Subnet donde vive. Tiene que tener ruta a un Internet Gateway, o el agente
    de SSM no se registra y la instancia arranca sana pero inalcanzable — que es
    el fallo mas confuso de este modulo.
  D
}

variable "sg_id" {
  type        = string
  description = "Su security group, sin reglas de entrada. Lo crea modules/security."
}

variable "instance_type" {
  type        = string
  description = <<-D
    t4g.nano alcanza de sobra: este host solo reenvia bytes. $0,0042/h.
    Si algun dia hay que correr un pg_dump grande desde aqui, t4g.small.
  D
  default     = "t4g.nano"
}
