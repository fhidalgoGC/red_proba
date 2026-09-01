#!/usr/bin/env bash
# Funciones compartidas. No se ejecuta solo.

set -euo pipefail

TF="${TF_BIN:-tofu}"
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOCS="$RAIZ/docs"

rojo()  { printf '\033[31m%s\033[0m\n' "$*"; }
verde() { printf '\033[32m%s\033[0m\n' "$*"; }
ambar() { printf '\033[33m%s\033[0m\n' "$*"; }
paso()  { printf '\n\033[1m══> %s\033[0m\n' "$*"; }

# Valida el argumento de escenario y deja $DIR listo.
#
# ⚠ SE EXIGE QUE HAYA .tf, no solo que exista la carpeta.
#
#   `50client/` existe y es un runbook, no un root module: la corrida de 50 se
#   hace sobre `oneClient` subiendo var.tenants (ver 50client/README.md). Con la
#   comprobacion antigua -solo `-d`- pasaba la validacion y tofu arrancaba en una
#   carpeta sin configuracion: `init` decia "Terraform initialized in an empty
#   directory" y el `apply` que venia detras informaba "No changes". Cero
#   recursos, cero errores, y la lectura obvia es "ya estaba todo aplicado".
escenario() {
  local e="${1:-}"
  case "$e" in
    oneClient|50client) ;;
    *) rojo "uso: $(basename "$0") <oneClient|50client> [opciones]"; exit 1 ;;
  esac
  ESC="$e"
  DIR="$RAIZ/$e"
  [ -d "$DIR" ] || { rojo "no existe $DIR"; exit 1; }
  if ! compgen -G "$DIR"/*.tf > /dev/null; then
    rojo "$e/ no tiene ningun .tf — no es un root module."
    echo
    ambar "la corrida de 50 se hace sobre oneClient, subiendo var.tenants:"
    echo "    sh terraform:deploy --clients 50 --az 1"
    echo
    echo "  por que:  $RAIZ/$e/README.md"
    exit 1
  fi
  cd "$DIR"
}

# Confirmacion explicita. Se salta con --si o AUTO=1.
confirmar() {
  local mensaje="$1"
  if [ "${AUTO:-0}" = "1" ]; then
    ambar "AUTO=1 — sin confirmar: $mensaje"
    return 0
  fi
  echo
  ambar "$mensaje"
  read -r -p "Escribi 'si' para continuar: " r
  [ "$r" = "si" ] || { echo "cancelado."; exit 1; }
}

# Vuelca outputs a terraform/docs/ para poder empujar imagenes despues
# sin tener que volver a correr terraform.
guardar_docs() {
  mkdir -p "$DOCS"
  local json="$DOCS/$ESC-outputs.json"
  local md="$DOCS/$ESC-referencia.md"

  $TF output -json > "$json" 2>/dev/null || { ambar "sin outputs todavia"; return 0; }

  {
    echo "# $ESC — referencia"
    echo
    echo "Generado por \`scripts/$(basename "$0")\` el $(date -u '+%Y-%m-%d %H:%M UTC')."
    echo "**No editar a mano** — se reescribe en cada crear/actualizar."
    echo
    echo '```'
    $TF output 2>/dev/null | sed 's/^/  /'
    echo '```'
    echo
    echo "## Empujar imágenes a ECR"
    echo
    echo '```bash'
    echo "aws ecr get-login-password --region \$(jq -r '.resumen.value.region' $ESC-outputs.json) \\"
    echo "  | docker login --username AWS --password-stdin \\"
    echo "      \$(jq -r '.ecr.value[\"c3-api\"]' $ESC-outputs.json | cut -d/ -f1)"
    echo '```'
    echo
    echo "Repos:"
    echo '```'
    jq -r '.ecr.value | to_entries[] | "  \(.key)\t\(.value)"' "$json" 2>/dev/null || echo "  (aplicar primero)"
    echo '```'
  } > "$md"

  verde "outputs guardados en docs/$ESC-outputs.json y docs/$ESC-referencia.md"
}

# ── La perilla de encendido, en un archivo ───────────────────────────────
#
# BUG QUE ESTO ARREGLA: pasar -var en el plan y luego aplicar el plan
# guardado da "Mismatch between input and plan variable value". Al aplicar
# un plan guardado, OpenTofu vuelve a leer terraform.tfvars y compara; un
# -var de linea de comandos no coincide con lo que hay en el archivo.
#
# En vez de pelear con eso, los scripts ESCRIBEN el valor. Asi el plan y el
# apply leen exactamente lo mismo, y de paso el estado de encendido queda
# visible en disco en vez de vivir en el historial de la terminal.
OVERRIDE="estado.auto.tfvars"

fijar_perilla() {   # fijar_perilla <desired_count>
  local dc="$1"
  cat > "$DIR/$OVERRIDE" <<EOF
# GENERADO POR scripts/ — no editar a mano.
# Escrito por $(basename "$0") el $(date -u '+%Y-%m-%d %H:%M UTC').
desired_count = $dc
EOF
}

perilla_actual() {
  [ -f "$DIR/$OVERRIDE" ] && grep -oE 'desired_count = [0-9]+' "$DIR/$OVERRIDE" | grep -oE '[0-9]+$' || echo "0"
}

# ¿Queda algo aplicado?
hay_estado() {
  [ -f "$DIR/terraform.tfstate" ] && [ "$($TF state list 2>/dev/null | wc -l | tr -d ' ')" != "0" ]
}
