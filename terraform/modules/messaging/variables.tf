variable "name_prefix" { type = string }
variable "kms_cola_arn" { type = string }
variable "rol_c3_id" { type = string }
variable "rol_c4_id" { type = string }
variable "rol_c3_arn" { type = string }

variable "permisos_de_task" {
  type        = bool
  description = <<-D
    Crear los permisos que atan esta cola a los task roles de C3 y C4: la
    resource policy de la cola y las dos politicas de identidad.

    La cola del DESPLIEGUE los quiere. La de DESARROLLO LOCAL no: ahi el que
    publica y consume es tu propio usuario, no el rol de una task de Fargate.

    ⚠ Y ADEMAS NO PUEDE TENERLOS. Las politicas de identidad son inline y con
      NOMBRE FIJO -"c3-sqs", "c4-sqs"- sobre roles que son los mismos para las
      dos instancias del modulo. `PutRolePolicy` con un nombre que ya existe
      SOBRESCRIBE: la segunda instancia le quitaria a la C3 desplegada el
      permiso sobre su cola y se lo daria sobre la local.

      Terraform no lo ve venir -son dos direcciones de recurso distintas- y el
      sintoma seria un `AccessDenied` en el relay de produccion despues de un
      apply que no toco nada de produccion. Si algun dia la cola local necesita
      permisos de rol, el nombre tiene que llevar el `name_prefix`.
  D
  default     = true
}

variable "max_receive_count" {
  type        = number
  description = "Recepciones antes de mandar el mensaje a la DLQ."
  default     = 5
}
