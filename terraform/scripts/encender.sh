#!/usr/bin/env bash
# ENCENDER — vuelve a levantar lo que apago apagar.sh.
#
# ⚠ Las imagenes tienen que estar en ECR. Sin ellas las tareas entran en
#   bucle de arranque con CannotPullContainerError.
#   Ver docs/<escenario>-referencia.md para los repos y el login.

source "$(dirname "${BASH_SOURCE[0]}")/_comun.sh"
escenario "${1:-}"
ambar "Recrea 12 interface endpoints (~\$0,12/h con 1 AZ). Tarda unos minutos."
fijar_perilla 1
$TF apply -input=false -auto-approve
guardar_docs
verde "$ESC encendido."
