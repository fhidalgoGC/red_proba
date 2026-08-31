terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source = "hashicorp/aws"
      # ECC_NIST_EDWARDS25519 y las reglas de SG como recurso propio
      # necesitan provider reciente.
      version = "~> 6.0"
    }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }

  # T-01 · Backend de estado remoto.
  # Comentado a proposito: para el humo de oneClient el estado local
  # alcanza y evita crear el bucket antes de saber si esto funciona.
  # Descomentar ANTES de 50client — ahi si hay mas de una persona
  # aplicando, y dos apply simultaneos con estado local lo corrompen.
  #
  # backend "s3" {
  #   bucket       = "rpf-poc-tfstate-<sufijo>"
  #   key          = "oneClient/terraform.tfstate"
  #   region       = "us-west-2"
  #   encrypt      = true
  #   use_lockfile = true
  # }
}

provider "aws" {
  region = var.region

  # ── Tags · TIENEN que existir antes del gasto ──
  # Cost Explorer no etiqueta retroactivamente uso pasado. Un apply sin
  # tags es un agujero permanente en el reporte. Ver ../COSTOS.md.
  default_tags {
    tags = {
      Project   = var.project
      Scenario  = "oneClient"
      Run       = var.run_id
      ManagedBy = "terraform"
      Owner     = var.owner
    }
  }
}
