variable "name_prefix" { type = string }
variable "tenants" {
  type        = list(string)
  description = "Lista de tenants. oneClient: [\"01\"]. 50client: [\"01\"..\"50\"]."
}
variable "vpc_ids" { type = map(string) }
variable "vpc_cidrs" { type = map(string) }

