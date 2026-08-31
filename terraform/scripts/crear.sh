#!/usr/bin/env bash
# CREAR — levanta el escenario desde cero.
#
#   scripts/crear.sh oneClient            infra sola, cero computo, ~$0/dia
#   scripts/crear.sh oneClient --encender infra + servicios corriendo
#
# Con --encender hacen falta las imagenes en ECR. Sin el, no: las tareas
# no arrancan, asi que nadie intenta hacer pull.

source "$(dirname "${BASH_SOURCE[0]}")/_comun.sh"
escenario "${1:-}"; shift || true

ENCENDER=0
for a in "$@"; do
  case "$a" in
    --encender) ENCENDER=1 ;;
    --si)       AUTO=1 ;;
    *) rojo "opcion desconocida: $a"; exit 1 ;;
  esac
done
DC=$([ "$ENCENDER" = "1" ] && echo 1 || echo 0)

if hay_estado; then
  ambar "Ya hay estado aplicado en $ESC."
  ambar "Para cambios incrementales usa  scripts/actualizar.sh $ESC"
  confirmar "Continuar igual (hara un apply sobre lo existente)?"
fi

paso "1/4 · init"
$TF init -input=false
fijar_perilla "$DC"

paso "2/4 · plan"
$TF plan -input=false -out=.plan.tfplan
echo
# OJO: nunca canalizar la salida de apply/plan a head — cierra el pipe,
# manda SIGPIPE y mata a tofu a mitad del apply. Se aprendio a la mala.
$TF show -no-color .plan.tfplan | grep -E '^Plan:' || true

if [ "$DC" = "0" ]; then
  verde "desired_count=0 · sin computo y sin interface endpoints. Estar creado cuesta ~\$0/dia."
else
  ambar "desired_count=1 · arranca computo Y crea 12 interface endpoints (~\$5,76/dia con 2 AZ)."
  ambar "Las imagenes tienen que existir en ECR o las tareas quedaran en bucle de arranque."
fi

confirmar "Se va a APLICAR el plan de arriba en la cuenta $(aws sts get-caller-identity --query Account --output text)."

paso "3/4 · apply"
$TF apply -input=false .plan.tfplan
rm -f .plan.tfplan

paso "4/4 · guardar referencia"
guardar_docs

echo
verde "══ $ESC creado ══"
echo "  Siguiente:  scripts/costos.sh dias 3     (el costo se lee mañana)"
[ "$DC" = "0" ] && echo "              scripts/encender.sh $ESC   (cuando haya imagenes)"
echo "  Al terminar: scripts/destruir.sh $ESC"
