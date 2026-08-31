#!/usr/bin/env bash
# Reporte de costos de la PoC.
#
# Ojo: Cost Explorer atrasa ~24 h. Esto NO sirve para vigilar una corrida
# en vivo — para eso están apagar.sh y verificar-limpio.sh.
set -uo pipefail

PROJECT_TAG="${PROJECT_TAG:-rpf-proof-ledger}"
# Gasto diario de la cuenta SIN la PoC. Medido 2026-08-22..28: $0,0811/dia,
# plano con variacion de +-$0,00002. Es lo que se resta para aislar la corrida.
# Revisar si alguien despliega algo mas en la cuenta.
BASELINE_DIARIO="${BASELINE_DIARIO:-0.0811}"
REGION="${AWS_REGION:-us-west-2}"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"

uso() {
  cat <<'USO'
uso: costos.sh <comando> [args]

  dias [n]                     ultimos n dias (default 14), total y delta vs baseline
  dia <YYYY-MM-DD>             desglose por servicio de UN dia
  resumen                      gasto del mes en curso, por servicio
  corrida <desde> <hasta>      gasto de un rango, por servicio   (YYYY-MM-DD)
  tags [desde] [hasta]         desglose por Scenario y Run
                               (requiere cost allocation tags ACTIVADAS por el payer)
  inventario                   qué recursos existen hoy con Project=rpf-proof-ledger
                               (funciona SIEMPRE, no depende de la activación)

Granularidad DIARIA: funciona hoy, sin depender del payer.
Granularidad HORARIA: bloqueada, requiere opt-in del payer 324005485665.
  -> Consecuencia práctica: UNA corrida de carga por día.
     Dos el mismo día no se pueden separar sin el tag `Run` activado.
Cost Explorer atrasa ~24 h: la corrida de hoy se lee mañana.
USO
}

por_servicio() {
  local desde="$1" hasta="$2"
  echo "── $desde → $hasta · cuenta $ACCOUNT"
  # --output text separa columnas con TAB. Sin FS="\t" awk parte
  # "AWS Key Management Service" en 4 campos y toma el importe equivocado.
  aws ce get-cost-and-usage \
    --time-period "Start=$desde,End=$hasta" \
    --granularity MONTHLY --metrics UnblendedCost \
    --group-by Type=DIMENSION,Key=SERVICE \
    --query 'ResultsByTime[].Groups[?Metrics.UnblendedCost.Amount!=`0`].[Keys[0],Metrics.UnblendedCost.Amount]' \
    --output text 2>/dev/null \
  | awk -F'\t' '{ printf "%014.6f\t%s\n", $2, $1 }' \
  | sort -r \
  | awk -F'\t' '{ printf "  %-45s %10.4f USD\n", $2, $1; t+=$1 }
                 END { if (t=="") t=0; printf "  %-45s %10.4f USD\n", "── TOTAL", t }'
}

case "${1:-}" in

  dias)
    n="${2:-14}"
    echo "── Últimos $n días · cuenta $ACCOUNT · baseline \$$BASELINE_DIARIO/día"
    echo
    printf "  %-12s %12s %12s   %s\n" FECHA TOTAL "DE LA POC" ""
    aws ce get-cost-and-usage \
      --time-period "Start=$(date -v-${n}d +%Y-%m-%d),End=$(date -v+1d +%Y-%m-%d)" \
      --granularity DAILY --metrics UnblendedCost \
      --query 'ResultsByTime[].[TimePeriod.Start,Total.UnblendedCost.Amount]' \
      --output text 2>/dev/null \
    | awk -v b="$BASELINE_DIARIO" -v hoy="$(date +%Y-%m-%d)" '\
        { d = $2 - b; if (d < 0.0005) d = 0; tot += d
          marca = (d > 0.5) ? "  <-- corrida" : ""
          if ($1 == hoy) marca = marca "  (dia en curso, parcial)"
          printf "  %-12s %12.4f %12.4f%s\n", $1, $2, d, marca }
        END { printf "\n  %-12s %12s %12.4f USD atribuibles a la PoC\n", "TOTAL", "", tot }'
    echo
    echo "  Un día en baseline (~\$$BASELINE_DIARIO) = la PoC no dejó nada encendido."
    ;;

  dia)
    [ $# -eq 2 ] || { uso; exit 1; }
    por_servicio "$2" "$(date -j -f %Y-%m-%d -v+1d "$2" +%Y-%m-%d)"
    ;;

  resumen)
    por_servicio "$(date +%Y-%m-01)" "$(date -v+1d +%Y-%m-%d)"
    ;;

  corrida)
    [ $# -eq 3 ] || { uso; exit 1; }
    por_servicio "$2" "$3"
    echo
    echo "  Recordá: KMS Sign es el renglón dominante (~\$0,15/10k ops)."
    echo "  Si 'AWS Key Management Service' no domina a 2.000 ev/s, revisá"
    echo "  que la firma esté ocurriendo de verdad y no fallando en silencio."
    ;;

  tags)
    desde="${2:-$(date +%Y-%m-01)}"
    hasta="${3:-$(date -v+1d +%Y-%m-%d)}"
    for K in Scenario Run Track Domain; do
      echo "── por $K · $desde → $hasta"
      out=$(aws ce get-cost-and-usage \
        --time-period "Start=$desde,End=$hasta" \
        --granularity MONTHLY --metrics UnblendedCost \
        --group-by "Type=TAG,Key=$K" \
        --query 'ResultsByTime[].Groups[].[Keys[0],Metrics.UnblendedCost.Amount]' \
        --output text 2>&1)
      if echo "$out" | grep -qi 'error\|not found\|invalid'; then
        echo "  ✗ tag '$K' no activada como cost allocation tag."
        echo "    La activa el payer 324005485665 (lmacias@vergedata.com)."
        echo "    Ver ../COSTOS.md. Tarda hasta 24 h en propagarse."
      else
        echo "$out" | awk '{ printf "  %-35s %10.4f USD\n", $1, $2 }'
      fi
      echo
    done
    ;;

  inventario)
    echo "── Recursos vivos con Project=$PROJECT_TAG · región $REGION"
    aws resourcegroupstaggingapi get-resources \
      --region "$REGION" \
      --tag-filters "Key=Project,Values=$PROJECT_TAG" \
      --query 'ResourceTagMappingList[].ResourceARN' --output text 2>/dev/null \
      | tr '\t' '\n' | sed 's|^|  |' | grep . \
      || echo "  (ninguno — la PoC no tiene nada desplegado)"
    echo
    echo "── Desglose por Scenario"
    for S in oneClient 50client; do
      n=$(aws resourcegroupstaggingapi get-resources --region "$REGION" \
            --tag-filters "Key=Project,Values=$PROJECT_TAG" "Key=Scenario,Values=$S" \
            --query 'length(ResourceTagMappingList)' --output text 2>/dev/null)
      printf "  %-12s %s recursos\n" "$S" "${n:-0}"
    done
    ;;

  *) uso; exit 1 ;;
esac
