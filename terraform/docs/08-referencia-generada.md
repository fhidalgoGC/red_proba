# 08 — La referencia generada

**No editar a mano.** Los scripts `crear.sh` y `actualizar.sh` reescriben estos dos
archivos después de cada `apply`, vía `guardar_docs()` en `scripts/_comun.sh`.

| Archivo | Qué es |
|---|---|
| `<escenario>-outputs.json` | todos los outputs de Terraform, crudos. Para `jq`. |
| `<escenario>-referencia.md` | lo mismo legible, más los comandos de login a ECR |

## Para qué sirve

Cuando haya que empujar imágenes, consultar la cola o verificar el invariante de
KMS, los IDs están acá — sin volver a correr Terraform y sin depender de que
alguien los haya anotado.

```bash
jq -r '.ecr.value["c3-api"]'      oneClient-outputs.json
jq -r '.cola_url.value'           oneClient-outputs.json
jq -r '.kms.value.firma_c3'       oneClient-outputs.json
jq -r '.db_endpoints.value'       oneClient-outputs.json
jq -r '.bucket_exportacion.value' oneClient-outputs.json
```

## Qué hay en los outputs

| Output | Qué trae |
|---|---|
| `resumen` | escenario, tenants, región, `run_id`, si está encendido |
| `cola_url` · `dlq_url` | las dos colas |
| `api_hosts` | lo que resuelve el orquestador por Cloud Map |
| `db_endpoints` | endpoints de RDS: `tenants` y `c4`. **Vacío cuando está apagado** |
| `ecr` | los tres repos donde hay que empujar antes de encender |
| `bucket_exportacion` | destino de logs y tablas. Exportar **antes** del destroy |
| `kms` | las cuatro llaves |
| `verificacion_invariante` | los dos comandos que **prueban** que C4 no puede firmar |

Ese último merece la pena leerlo entero: son los comandos que se corren delante de
quien pregunte, no una afirmación del diseño.

## Ojo: es un espejo, no el estado

La fuente de verdad sigue siendo `terraform.tfstate` en la carpeta del escenario.
Si pierdes el state, estos archivos te dicen qué existía pero **no permiten
destruirlo** — habría que borrar a mano.

Por eso `versions.tf` tiene el backend remoto listo para descomentar antes de
`50client`: son dos cuentas y va a haber más de una persona aplicando, y con state
local dos `apply` simultáneos corrompen el estado.
