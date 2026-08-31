variable "region" {
  type        = string
  description = "Region. us-west-2 es la configurada en la CLI de esta cuenta."
  default     = "us-west-2"
}

variable "project" {
  type    = string
  default = "rpf-proof-ledger"
}

variable "name_prefix" {
  type        = string
  description = "Prefijo de todos los nombres. Tambien aisla oneClient de 50client."
  default     = "rpf-one"
}

variable "run_id" {
  type        = string
  description = <<-D
    Identificador de corrida. Es la tag que permite decir "la corrida del
    martes costo $X" en vez de "agosto costo $Y".

    El costo ya facturado conserva el valor que la tag tenia en ese
    momento, asi que cambiarlo no reescribe el pasado ni recrea recursos.

    ⚠ Sin granularidad horaria -bloqueada por el payer- dos corridas el
      mismo dia no se separan. Una corrida de carga por dia.
  D
  default     = "2026-08-29-humo"
}

variable "owner" {
  type    = string
  default = "fhidalgo@grainchain.io"
}

# ── La unica diferencia real con 50client ────────────────────────────────
variable "tenants" {
  type        = list(string)
  description = "oneClient: un solo tenant. 50client pasa [\"01\" ... \"50\"]."
  default     = ["01"]
}

# ── CIDR ─────────────────────────────────────────────────────────────────
# ⚠ La cuenta ya tiene 10.0.0.0/16 y 10.16.0.0/16 de otro equipo.
#   Arrancamos en 10.100 para no chocar. El peering falla al crearse si
#   los CIDR se traslapan.
variable "cidr_orq" {
  type    = string
  default = "10.100.0.0/16"
}
variable "cidr_c3" {
  type    = string
  default = "10.101.0.0/16"
}
variable "cidr_c4" {
  type    = string
  default = "10.102.0.0/16"
}
variable "az_count" {
  type        = number
  description = "AZs por VPC. Cada interface endpoint cobra una ENI por AZ."
  default     = 2
}

# ── T-07 · La perilla de apagado ─────────────────────────────────────────
variable "desired_count" {
  type        = number
  description = <<-D
    0 = infraestructura creada, cero computo, cero pull de imagenes.
    1 = servicios corriendo.

    Con 0 se puede aplicar TODO antes de que existan los contenedores.
    Entre corridas se apaga con 0, no se destruye: deja de facturar en
    segundos y conserva red, llaves, colas y datos.
  D
  default     = 0
}

variable "imagen_tag" {
  type        = string
  description = "Tag de las imagenes en ECR. 'humo' para las prestadas."
  default     = "humo"
}

variable "log_retention_days" {
  type    = number
  default = 1
}
variable "presupuesto_mensual_usd" {
  type        = string
  description = <<-D
    Umbral de alerta mensual. El baseline de la cuenta sin la PoC es
    ~$2,45/mes, asi que cualquier valor por encima de ~$20 significa que
    algo quedo prendido.
  D
  default     = "50"
}

variable "exportacion_retencion_dias" {
  type        = number
  description = "Dias que sobreviven los logs y tablas exportados a S3."
  default     = 30
}

variable "endpoints_activos" {
  type        = bool
  description = <<-D
    null  = siguen a desired_count (recomendado: apagado cuesta ~$0)
    true  = siempre encendidos, ~$7,20/dia con 2 AZ aunque no corra nada
    false = siempre apagados; las tareas NO pueden arrancar sin ellos
  D
  default     = null
}

# ── RDS ───────────────────────────────────────────────────────────────────
variable "rds_persistente" {
  type        = bool
  description = <<-D
    RDS no se puede escalar a cero: la unica forma de no pagarlo es
    destruir la instancia.

    false (defecto) → RDS sigue la perilla de encendido. Apagar borra la
                      base. Estar apagado sigue costando ~$0,15/dia.
    true            → la base existe siempre y sobrevive a los apagados,
                      pero cuesta ~$2,10/dia en oneClient aunque no corra
                      nada.
  D
  default     = false
}

variable "rds_class_tenant" {
  type        = string
  description = "Clase de la base de cada tenant. A 40 ev/s, micro alcanza."
  default     = "db.t4g.micro"
}

variable "rds_class_c4" {
  type        = string
  description = <<-D
    Clase de la base de C4. Recibe TODO el trafico -2.000 ev/s en
    50client, no 40 como un tenant-, asi que lleva mas.

    NOTA PARA 50client, no para el humo: la familia t4g es de RAFAGA.
    Funciona con creditos de CPU y al agotarlos se estrangula al baseline.
    Una corrida sostenida de 5 h a 2.000 ev/s los agota, y el sintoma es
    el mismo que el throttling de KMS: la latencia crece, el outbox se
    llena y NINGUN error lo explica.

    Si al medir 50client el intervalo e9->e10 -persistencia en C4- crece
    sin que crezcan los otros, sospechar de esto antes que del codigo, y
    pasar a db.m6g.large (2 vCPU sin rafaga, 8 GiB).
  D
  default     = "db.t4g.medium"
}

variable "rds_engine_version" {
  type    = string
  default = "16.4"
}

variable "rds_storage_gb" {
  type        = number
  description = "20 GB es el minimo de RDS."
  default     = 20
}
