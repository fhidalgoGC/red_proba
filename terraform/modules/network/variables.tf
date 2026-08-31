variable "name_prefix" { type = string }

variable "cidr_orq" { type = string }
variable "cidr_c3" { type = string }
variable "cidr_c4" { type = string }

variable "az_count" {
  type        = number
  description = <<-D
    AZs por VPC. El doc pide 2. Cada interface endpoint cobra por ENI y hay
    una ENI por AZ, asi que az_count=1 casi divide a la mitad el costo fijo
    de endpoints — util para humo, pero deja de ser representativo.
  D
  default     = 2
}

variable "namespace" {
  type        = string
  description = "Zona privada de Cloud Map. api-NN.<namespace>, db-NN.<namespace>."
  default     = "poc.local"
}

variable "endpoints_activos" {
  type        = bool
  description = <<-D
    ⚠ LOS INTERFACE ENDPOINTS FACTURAN AUNQUE NO CORRA NADA.
    Cobran ~$0,01 por hora POR ENI, y hay una ENI por AZ por endpoint.
    Con 15 endpoints y 2 AZ son 30 ENIs = ~$0,30/h = ~$7,20/dia — casi
    3x el baseline mensual de la cuenta, por dia, con cero computo.

    Por eso siguen a desired_count: apagar la PoC apaga tambien los
    endpoints, y el costo de estar apagado cae a ~$0.

    El precio a pagar: encender tarda unos minutos mas mientras los
    endpoints se recrean y el DNS privado propaga.
  D
}
