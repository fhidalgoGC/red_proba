# oneClient — referencia

Generado por `scripts/actualizar.sh` el 2026-08-30 04:16 UTC.
**No editar a mano** — se reescribe en cada crear/actualizar.

```
  api_hosts = {
    "01" = "api-01.poc.local"
  }
  bucket_exportacion = "rpf-one-exportacion-74360e71"
  cola_url = "https://sqs.us-west-2.amazonaws.com/276076558677/rpf-one-eventos.fifo"
  db_endpoints = {
    "c4" = ""
    "tenants" = {}
  }
  dlq_url = "https://sqs.us-west-2.amazonaws.com/276076558677/rpf-one-eventos-dlq.fifo"
  ecr = {
    "c3-api" = "276076558677.dkr.ecr.us-west-2.amazonaws.com/rpf-one-c3-api"
    "c4-consumer" = "276076558677.dkr.ecr.us-west-2.amazonaws.com/rpf-one-c4-consumer"
    "orq-driver" = "276076558677.dkr.ecr.us-west-2.amazonaws.com/rpf-one-orq-driver"
  }
  kms = {
    "cola_c4" = "arn:aws:kms:us-west-2:276076558677:key/18803e57-d100-45de-b287-3a49e62ab533"
    "firma_c3" = "arn:aws:kms:us-west-2:276076558677:key/9c2ba3c2-e111-463a-871f-c1ee048dbefa"
    "hmac_c3" = "arn:aws:kms:us-west-2:276076558677:key/83695b89-189e-479d-800a-9bda424ecabd"
    "mensajes_c4" = "arn:aws:kms:us-west-2:276076558677:key/f8940502-057c-42b3-9a09-8d40cf673f68"
  }
  resumen = {
    "desired_count" = 0
    "encendido" = "NO — solo infra, cero computo"
    "escenario" = "oneClient"
    "region" = "us-west-2"
    "run_id" = "2026-08-29-humo"
    "tenants" = tolist([
      "01",
    ])
  }
  verificacion_invariante = {
    "c4_no_firma" = "aws kms sign --key-id arn:aws:kms:us-west-2:276076558677:key/9c2ba3c2-e111-463a-871f-c1ee048dbefa --message $(echo -n test | base64) --signing-algorithm ED25519_SHA_512 --message-type RAW  # asumiendo el rol de C4 DEBE dar AccessDenied"
    "c4_si_lee" = "aws kms get-public-key --key-id arn:aws:kms:us-west-2:276076558677:key/9c2ba3c2-e111-463a-871f-c1ee048dbefa  # asumiendo el rol de C4 DEBE funcionar"
  }
```

## Empujar imágenes a ECR

```bash
aws ecr get-login-password --region $(jq -r '.resumen.value.region' oneClient-outputs.json) \
  | docker login --username AWS --password-stdin \
      $(jq -r '.ecr.value["c3-api"]' oneClient-outputs.json | cut -d/ -f1)
```

Repos:
```
  c3-api	276076558677.dkr.ecr.us-west-2.amazonaws.com/rpf-one-c3-api
  c4-consumer	276076558677.dkr.ecr.us-west-2.amazonaws.com/rpf-one-c4-consumer
  orq-driver	276076558677.dkr.ecr.us-west-2.amazonaws.com/rpf-one-orq-driver
```
