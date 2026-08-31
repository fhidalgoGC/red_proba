#!/usr/bin/env bash
# ACTUALIZAR — aplica cambios sobre lo que ya existe.
#
#   scripts/actualizar.sh oneClient
#   scripts/actualizar.sh oneClient --var 'imagen_tag=v2'
#
# Muestra el diff y pide confirmacion ANTES de tocar nada. Si el plan
# incluye destrucciones, lo avisa fuerte: en esta PoC un replace de la
# tarea de Postgres se lleva el outbox con ella.

source "$(dirname "${BASH_SOURCE[0]}")/_comun.sh"
escenario "${1:-}"; shift || true

EXTRA=()
while [ $# -gt 0 ]; do
  case "$1" in
    --si)  AUTO=1; shift ;;
    --var) EXTRA+=(-var "$2"); shift 2 ;;
    *)     rojo "opcion desconocida: $1"; exit 1 ;;
  esac
done

hay_estado || { rojo "No hay nada aplicado en $ESC. Usa  scripts/crear.sh $ESC"; exit 1; }

paso "1/3 · plan"
$TF init -input=false -upgrade=false >/dev/null
# La perilla se conserva tal cual esta; actualizar no enciende ni apaga.
[ -f "$DIR/$OVERRIDE" ] || fijar_perilla 0
$TF plan -input=false ${EXTRA[@]+"${EXTRA[@]}"} -out=.plan.tfplan

RESUMEN=$($TF show -no-color .plan.tfplan | grep -E '^Plan:' || echo "Plan: sin cambios")
echo; echo "  $RESUMEN"

if echo "$RESUMEN" | grep -qE '[1-9][0-9]* to destroy'; then
  echo
  rojo "⚠ ESTE PLAN DESTRUYE RECURSOS."
  ambar "  Las instancias RDS van con skip_final_snapshot: si una se"
  ambar "  destruye o se reemplaza, su outbox se pierde y en la demo"
  ambar "  se ve como perdida de eventos aunque el patron este bien."
  echo
  $TF show -no-color .plan.tfplan | grep -E 'will be destroyed|must be replaced' | sed 's/^/    /'
fi

if echo "$RESUMEN" | grep -q 'Plan: 0 to add, 0 to change, 0 to destroy'; then
  rm -f .plan.tfplan
  verde "Nada que hacer — la infraestructura ya coincide con el codigo."
  exit 0
fi

confirmar "Aplicar estos cambios."

paso "2/3 · apply"
$TF apply -input=false .plan.tfplan
rm -f .plan.tfplan

paso "3/3 · guardar referencia"
guardar_docs
verde "══ $ESC actualizado ══"
