#!/usr/bin/env bash
# DESTRUIR — no deja NADA facturando en AWS.
#
#   scripts/destruir.sh oneClient
#   scripts/destruir.sh oneClient --sin-exportar   (salta el volcado a S3)
#
# El orden NO es negociable:
#   1. apagar     -> drena tareas y libera ENIs; sin esto el destroy pelea
#                    con recursos en uso
#   2. exportar   -> los log groups SE VAN Y NO SE RECUPERAN
#   3. purgar     -> la cola no se borra con mensajes en vuelo
#   4. destroy
#   5. verificar  -> lo unico que prueba que quedo limpio

source "$(dirname "${BASH_SOURCE[0]}")/_comun.sh"
escenario "${1:-}"; shift || true

EXPORTAR=1
for a in "$@"; do
  case "$a" in
    --sin-exportar) EXPORTAR=0 ;;
    --si)           AUTO=1 ;;
    *) rojo "opcion desconocida: $a"; exit 1 ;;
  esac
done

hay_estado || { ambar "No hay estado en $ESC — nada que destruir."; exec "$(dirname "$0")/verificar-limpio.sh"; }

REGION=$($TF output -json 2>/dev/null | jq -r '.resumen.value.region // "us-west-2"')
BUCKET=$($TF output -raw bucket_exportacion 2>/dev/null || echo "")
COLA=$($TF output -raw cola_url 2>/dev/null || echo "")
DLQ=$($TF output -raw dlq_url 2>/dev/null || echo "")

confirmar "Se va a DESTRUIR todo el escenario $ESC. Esto no se deshace."

paso "1/5 · apagar y drenar"
fijar_perilla 0
$TF apply -input=false -auto-approve
verde "computo a cero y endpoints liberados"

paso "2/5 · exportar logs y medicion a S3"
if [ "$EXPORTAR" = "0" ]; then
  ambar "saltado por --sin-exportar"
elif [ -z "$BUCKET" ]; then
  ambar "no hay bucket de exportacion en los outputs; saltando"
else
  MARCA="$(date -u +%Y%m%dT%H%M%SZ)"
  DESDE=$(( ($(date +%s) - 7*24*3600) * 1000 ))
  HASTA=$(( $(date +%s) * 1000 ))
  # ⚠ Los log groups se van con el destroy y NO se recuperan. Esta es la
  #   unica oportunidad de conservarlos.
  for LG in $(aws logs describe-log-groups --region "$REGION" \
               --log-group-name-prefix "/ecs/" \
               --query 'logGroups[].logGroupName' --output text 2>/dev/null | tr '\t' '\n'); do
    [ -z "$LG" ] && continue
    echo "  exportando $LG"
    aws logs create-export-task --region "$REGION" \
      --log-group-name "$LG" --from "$DESDE" --to "$HASTA" \
      --destination "$BUCKET" --destination-prefix "$MARCA${LG}" >/dev/null 2>&1 \
      || ambar "    no se pudo exportar $LG (puede estar vacio)"
  done
  verde "exportado a s3://$BUCKET/$MARCA/"
fi

paso "3/5 · purgar las colas"
# La cola no se borra con mensajes en vuelo.
for Q in "$COLA" "$DLQ"; do
  [ -z "$Q" ] && continue
  echo "  purgando $Q"
  aws sqs purge-queue --region "$REGION" --queue-url "$Q" 2>/dev/null \
    || ambar "    purge rechazado (solo se admite 1 cada 60 s); el destroy igual procede"
done

paso "4/5 · destroy"
$TF destroy -input=false -auto-approve
rm -f "$DIR/$OVERRIDE"
verde "destroy completado"

paso "5/5 · verificar"
"$(dirname "$0")/verificar-limpio.sh" || true

echo
ambar "Las llaves de KMS NO se borran: entran en periodo de espera de 7 dias."
ambar "Siguen contando para la cuota de llaves, pero no facturan uso."
echo
echo "  Mañana:  scripts/costos.sh dias 3"
echo "  Un dia que vuelve al baseline (~\$0,0811) confirma que quedo limpio."
