# oneClient — referencia

Generado por `scripts/encender.sh` el 2026-08-31 23:26 UTC.
**No editar a mano** — se reescribe en cada crear/actualizar.

```
  api_hosts = {
    "01" = "api-01.poc.local"
  }
  bastiones = {
    "c3" = "i-066f1fdddd372b073"
    "c4" = "i-02ba67a20b44821ce"
  }
  bucket_exportacion = "rpf-one-exportacion-74360e71"
  cola_local_url = "https://sqs.us-west-2.amazonaws.com/276076558677/rpf-one-local-eventos.fifo"
  cola_url = "https://sqs.us-west-2.amazonaws.com/276076558677/rpf-one-eventos.fifo"
  db_endpoints = {
    "c4" = "rpf-one-c4-db.cqvmxq0evdzn.us-west-2.rds.amazonaws.com"
    "tenants" = {
      "01" = "rpf-one-db-01.cqvmxq0evdzn.us-west-2.rds.amazonaws.com"
    }
  }
  dlq_local_url = "https://sqs.us-west-2.amazonaws.com/276076558677/rpf-one-local-eventos-dlq.fifo"
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
    "desired_count" = 1
    "encendido" = "SI — facturando computo"
    "escenario" = "oneClient"
    "region" = "us-west-2"
    "run_id" = "2026-08-31-humo"
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
