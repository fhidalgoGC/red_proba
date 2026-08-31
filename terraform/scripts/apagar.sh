#!/usr/bin/env bash
# APAGAR — corta el computo sin destruir. T-07.
#
# Conserva red, llaves, colas y DATOS. Tambien libera los interface
# endpoints, que son el costo fijo real (~$0,15/h con 1 AZ).
# Entre corridas se apaga, no se destruye.

source "$(dirname "${BASH_SOURCE[0]}")/_comun.sh"
escenario "${1:-}"
fijar_perilla 0
$TF apply -input=false -auto-approve
guardar_docs
verde "$ESC apagado — computo y endpoints a cero. Red, llaves, colas y datos intactos."
