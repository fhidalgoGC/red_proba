variable "name_prefix" { type = string }
variable "repos" {
  type    = list(string)
  default = ["c3-api", "c4-consumer", "orq-driver", "postgres"]
}
