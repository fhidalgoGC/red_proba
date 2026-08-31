# terraform/docs — referencia generada

**No editar a mano.** Los scripts `crear.sh` y `actualizar.sh` reescriben
esto después de cada `apply`.

## Qué hay acá

| Archivo | Qué es |
|---|---|
| `<escenario>-outputs.json` | Todos los outputs de Terraform, crudos. Para `jq`. |
| `<escenario>-referencia.md` | Lo mismo legible, más los comandos de login a ECR. |

## Para qué sirve

Cuando haya que empujar imágenes, consultar la cola o verificar el
invariante de KMS, los IDs están acá — sin volver a correr Terraform y sin
depender de que alguien los haya anotado.

```bash
jq -r '.ecr.value["c3-api"]'      docs/oneClient-outputs.json
jq -r '.cola_url.value'           docs/oneClient-outputs.json
jq -r '.kms.value.firma_c3'       docs/oneClient-outputs.json
jq -r '.bucket_exportacion.value' docs/oneClient-outputs.json
```

## Ojo

Esto es un **espejo** del estado, no el estado. La fuente de verdad sigue
siendo `terraform.tfstate` en la carpeta del escenario. Si perdés el state,
estos archivos te dicen qué existía pero no permiten destruirlo — habría
que borrar a mano. Por eso `versions.tf` tiene el backend remoto listo para
descomentar antes de `50client`.
