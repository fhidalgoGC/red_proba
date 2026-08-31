output "resumen" {
  description = "Lo que hay que saber para operar la corrida."
  value = {
    escenario     = "oneClient"
    tenants       = var.tenants
    region        = var.region
    run_id        = var.run_id
    desired_count = var.desired_count
    encendido     = var.desired_count > 0 ? "SI — facturando computo" : "NO — solo infra, cero computo"
  }
}

output "cola_url" { value = module.messaging.cola_url }
output "dlq_url" { value = module.messaging.dlq_url }

output "api_hosts" {
  description = "Lo que resuelve el orquestador por Cloud Map."
  value       = module.tenant.api_hosts
}
output "db_endpoints" {
  description = <<-D
    Endpoints de RDS. Vacio cuando la PoC esta apagada: RDS no escala a
    cero, asi que apagar destruye las instancias.
  D
  value = {
    tenants = module.tenant.db_endpoints
    c4      = module.c4.db_endpoint
  }
}

output "ecr" {
  description = "Repos donde hay que empujar las imagenes antes de encender."
  value       = module.registry.urls
}

output "bucket_exportacion" {
  description = "Destino de logs y tablas de medicion. Exportar ANTES del destroy."
  value       = aws_s3_bucket.exportacion.bucket
}

output "kms" {
  description = "Las cuatro llaves. La asimetria es el invariante."
  value = {
    firma_c3    = module.security.kms_firma_arn
    hmac_c3     = module.security.kms_hmac_arn
    mensajes_c4 = module.security.kms_mensajes_arn
    cola_c4     = module.security.kms_cola_arn
  }
}

output "verificacion_invariante" {
  description = "Comandos que PRUEBAN que C4 no puede firmar. Correr tras encender."
  value = {
    c4_no_firma = "aws kms sign --key-id ${module.security.kms_firma_arn} --message $(echo -n test | base64) --signing-algorithm ED25519_SHA_512 --message-type RAW  # asumiendo el rol de C4 DEBE dar AccessDenied"
    c4_si_lee   = "aws kms get-public-key --key-id ${module.security.kms_firma_arn}  # asumiendo el rol de C4 DEBE funcionar"
  }
}
