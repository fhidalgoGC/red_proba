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

variable "manifiesto_tope" {
  type        = number
  default     = null
  description = <<-D
    Expedientes distintos que el manifiesto de O-08 guarda antes de empezar a
    OMITIR. `null` = no se inyecta y manda el default del codigo (200.000).

    ⚠ ES EL LIMITE QUE DEJA P4 SIN RESPUESTA, y no avisa hasta que ya paso.
      La conciliacion solo da `ok` cuando el manifiesto NO esta truncado
      (`conciliacion/conciliar.ts`): en cuanto se alcanza el tope, la corrida
      entera queda con asterisco por muchos eventos que hayan llegado bien.

      Con `eventos_por_hilo: 1` cada evento es su propio expediente, asi que el
      tope se traduce directo a segundos de corrida:

        1 tenant  ·    40 ev/s  →  200.000 / 40    = 5.000 s  (83 min)  sobra
        50 tenants · 2.000 ev/s →  200.000 / 2.000 =     100 s (1,6 min) NO
        50 tenants · 3.000 ev/s →  200.000 / 3.000 =      67 s          NO

      Por eso con 1 tenant nunca se noto y con 50 se nota a los dos minutos.

    Cuanto subirlo: son ~220 bytes por expediente en el heap. Una corrida de
    30 min a 3.000 ev/s son 5,4 M de expedientes ≈ 1,2 GB, y la task tiene
    6.144 MB de heap (NODE_OPTIONS) sobre 8 GiB — cabe con margen.

    La otra salida es `eventos_por_hilo: 10` en el cuerpo del batch: divide los
    expedientes por diez sin tocar la memoria. Las dos valen; lo que no vale es
    dejarlo al default y descubrirlo al conciliar.
  D
}

variable "acceso_externo" {
  type        = bool
  description = "Sin efecto en este modulo desde que el acceso va por bastion. Se conserva para no romper llamadas existentes."
  default     = false
}
