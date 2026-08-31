#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# terraform:deploy — despliega la PoC en AWS, y la apaga.
#
#   sh terraform:deploy --clients 1     despliega con 1 tenant  ← la prueba inicial
#   sh terraform:deploy --clients 50    idem con 50 (maximo 200)
#   sh terraform:deploy --down          APAGA: computo y endpoints a cero
#   sh terraform:deploy --estado        que hay desplegado y en que estado
#   sh terraform:deploy --plan          enseña el plan y no aplica nada
#
#   --sin-encender   crea la infraestructura pero la deja parada
#   --az 1|2         AZs por VPC (cada endpoint pone UNA ENI POR AZ)
#   --si             sin confirmaciones
#
# ── Que hace de verdad ──────────────────────────────────────────────────────
#
# No reimplementa Terraform: escribe la lista de tenants y delega en
# terraform/scripts/, que ya resuelven el plan guardado, las confirmaciones y
# el volcado de outputs. Lo unico que añade es lo que faltaba — decidir CUANTOS
# clientes y con que consecuencias.
#
# ⚠ El escenario es `oneClient` incluso con 50 clientes. No es un descuido: es
# el UNICO root module con codigo (`50client/` solo tiene README), y el propio
# README del track dice que lo unico que distingue a un escenario de otro es
# `var.tenants`. Duplicar el codigo para cambiar un numero es justo lo que ese
# documento prohibe: lo que validas con 1 tenant dejaria de ser lo que corres
# con 50.
#
# ⚠ La lista de tenants se escribe en `clientes.auto.tfvars`, con el mismo
# patron que `estado.auto.tfvars`: pasar `-var` en el plan y luego aplicar el
# plan guardado da «Mismatch between input and plan variable value», porque al
# aplicar un plan guardado OpenTofu vuelve a leer los tfvars y compara.
# ─────────────────────────────────────────────────────────────────────────────
set -u

RAIZ=$(cd "$(dirname "$0")" && pwd)
cd "$RAIZ" || exit 1

TF=${TF_BIN:-tofu}
ESCENARIO=${ESCENARIO:-oneClient}
MAX_CLIENTES=200
SCRIPTS="$RAIZ/terraform/scripts"

# ── Coste, en ordenes de magnitud ───────────────────────────────────────────
# Salen de terraform/COSTOS.md y de los comentarios de oneClient/terraform.tfvars.
# Son el SUELO —endpoints y RDS—, sin Fargate ni las firmas de KMS, que es el
# renglon dominante bajo carga. Para el numero real: scripts/costos.sh.
USD_DIA_ENDPOINTS_POR_AZ=2.88   # 12 interface endpoints × 1 ENI por AZ
USD_DIA_RDS_TENANT=0.45         # db.t4g.micro + 20 GB
USD_DIA_RDS_C4=1.65             # db.t4g.medium + 20 GB

if [ -t 1 ]; then
  A_ROJO=$(printf '\033[31m'); A_VERDE=$(printf '\033[32m')
  A_AMBAR=$(printf '\033[33m'); A_GRIS=$(printf '\033[90m')
  A_FUERTE=$(printf '\033[1m'); A_FIN=$(printf '\033[0m')
else
  A_ROJO=''; A_VERDE=''; A_AMBAR=''; A_GRIS=''; A_FUERTE=''; A_FIN=''
fi

paso()  { printf '\n%s▸ %s%s\n' "$A_FUERTE" "$*" "$A_FIN"; }
ok()    { printf '  %s✔%s %s\n' "$A_VERDE" "$A_FIN" "$*"; }
aviso() { printf '  %s!%s %s\n' "$A_AMBAR" "$A_FIN" "$*"; }
malo()  { printf '  %s✘%s %s\n' "$A_ROJO" "$A_FIN" "$*"; }
tenue() { printf '  %s%s%s\n' "$A_GRIS" "$*" "$A_FIN"; }
morir() { printf '\n%s✘ %s%s\n\n' "$A_ROJO" "$*" "$A_FIN"; exit 1; }

DIR="$RAIZ/terraform/$ESCENARIO"
CLIENTES_TFVARS="$DIR/clientes.auto.tfvars"
PERILLA_TFVARS="$DIR/estado.auto.tfvars"

tf() { (cd "$DIR" && "$TF" "$@"); }

hay_estado() {
  [ -f "$DIR/terraform.tfstate" ] && [ "$(tf state list 2>/dev/null | wc -l | tr -d ' ')" != "0" ]
}
perilla() {
  [ -f "$PERILLA_TFVARS" ] && grep -oE 'desired_count = [0-9]+' "$PERILLA_TFVARS" | grep -oE '[0-9]+$' || echo 0
}
clientes_actuales() {
  # El archivo es la fuente de verdad cuando existe. Si no —porque el
  # despliegue se hizo antes que este script— se cuentan del estado real, que
  # es lo que de verdad hay en la cuenta.
  if [ -f "$CLIENTES_TFVARS" ]; then
    grep -oE '"[0-9]+"' "$CLIENTES_TFVARS" | wc -l | tr -d ' '
    return
  fi
  _n=$(tf output -json api_hosts 2>/dev/null | jq 'length' 2>/dev/null)
  case "${_n:-}" in ''|*[!0-9]*) echo "?" ;; *) echo "$_n" ;; esac
}
imagen_tag() {
  grep -E '^\s*imagen_tag' "$DIR/terraform.tfvars" 2>/dev/null | sed 's/.*= *"\(.*\)".*/\1/' | head -1
}

# ── ARGUMENTOS ──────────────────────────────────────────────────────────────
ACCION=""; CLIENTES=""; AZ=""; SI=0; ENCENDER=auto

while [ $# -gt 0 ]; do
  case "$1" in
    --clients|--clientes)
      ACCION=desplegar
      CLIENTES=${2:-}
      [ -n "$CLIENTES" ] || morir "--clients necesita un numero: --clients 1"
      shift 2 ;;
    --down|--apagar)      ACCION=apagar; shift ;;
    --estado|--status)    ACCION=estado; shift ;;
    --plan)               ACCION=${ACCION:-desplegar}; SOLO_PLAN=1; shift ;;
    --sin-encender)       ENCENDER=no; shift ;;
    --encender)           ENCENDER=si; shift ;;
    --az)                 AZ=${2:-}; shift 2 ;;
    --si|-y)              SI=1; shift ;;
    --escenario)          ESCENARIO=${2:-}; DIR="$RAIZ/terraform/$ESCENARIO"
                          CLIENTES_TFVARS="$DIR/clientes.auto.tfvars"
                          PERILLA_TFVARS="$DIR/estado.auto.tfvars"; shift 2 ;;
    -h|--help|'')         sed -n '3,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)                    morir "opcion desconocida: $1 · usa --clients N | --down | --estado" ;;
  esac
done
SOLO_PLAN=${SOLO_PLAN:-0}
[ -n "$ACCION" ] || morir "no dijiste que hacer · --clients N | --down | --estado"

printf '\n%s┌─────────────────────────────────────────────┐%s\n' "$A_FUERTE" "$A_FIN"
printf '%s│  terraform:deploy · PoC RPF Proof Ledger     │%s\n' "$A_FUERTE" "$A_FIN"
printf '%s└─────────────────────────────────────────────┘%s\n' "$A_FUERTE" "$A_FIN"

# ── VERIFICAR PRIMERO ───────────────────────────────────────────────────────
paso "Verificación"
command -v "$TF" >/dev/null 2>&1 || morir "falta '$TF' · brew install opentofu (o TF_BIN=terraform)"
command -v aws  >/dev/null 2>&1 || morir "falta la CLI de AWS"
command -v jq   >/dev/null 2>&1 || morir "falta jq"
[ -d "$DIR" ] || morir "no existe terraform/$ESCENARIO"
ok "$("$TF" version | head -1) · escenario $ESCENARIO"

CUENTA=$(aws sts get-caller-identity --query Account --output text 2>/dev/null) \
  || morir "las credenciales de AWS no responden · aws sso login / aws configure"
REGION=$(aws configure get region 2>/dev/null || echo us-west-2)
ok "cuenta $CUENTA · región $REGION"

if hay_estado; then
  ok "estado aplicado · $(tf state list 2>/dev/null | wc -l | tr -d ' ') recursos · $(clientes_actuales) cliente(s) · desired_count=$(perilla)"
else
  tenue "sin estado previo · esto seria un despliegue desde cero"
fi

# ═══ ESTADO ══════════════════════════════════════════════════════════════════
if [ "$ACCION" = "estado" ]; then
  if ! hay_estado; then
    paso "Nada desplegado"
    tenue "desplegar:  sh terraform:deploy --clients 1"
    printf '\n'; exit 0
  fi
  paso "Desplegado"
  printf '  %-16s %s\n' "clientes" "$(clientes_actuales)"
  printf '  %-16s %s\n' "desired_count" "$(perilla) $( [ "$(perilla)" = "0" ] && echo '· APAGADO, sin cómputo ni endpoints' || echo '· encendido' )"
  printf '  %-16s %s\n' "recursos" "$(tf state list 2>/dev/null | wc -l | tr -d ' ')"
  tf output 2>/dev/null | sed "s/^/  ${A_GRIS}/;s/$/${A_FIN}/" | head -20
  printf '\n'
  tenue "costo real: terraform/scripts/costos.sh dias 3"
  printf '\n'; exit 0
fi

# ═══ APAGAR ══════════════════════════════════════════════════════════════════
if [ "$ACCION" = "apagar" ]; then
  hay_estado || { paso "No hay nada que apagar"; printf '\n'; exit 0; }
  if [ "$(perilla)" = "0" ]; then
    paso "Ya estaba apagado"
    tenue "desired_count=0 · sin cómputo y sin interface endpoints"
    printf '\n'
  else
    paso "Apagando · T-07"
    tenue "computo y endpoints a cero. Conserva red, llaves y colas."
    tenue "los DATOS no: RDS no escala a cero y sigue la misma perilla."
    AUTO=$SI sh "$SCRIPTS/apagar.sh" "$ESCENARIO" || morir "el apagado fallo"
  fi

  paso "Lo que sigue costando"
  tenue "S3 de exportación · Secrets Manager · CloudWatch Logs — centavos al día"
  # Es la unica pieza que no se puede escalar a cero, y por eso se dice aqui:
  # descubrirlo en la factura es peor que leerlo ahora.
  if grep -qE '^\s*rds_persistente\s*=\s*true' "$DIR/terraform.tfvars" 2>/dev/null; then
    aviso "rds_persistente=true · las bases SIGUEN vivas y facturando (~\$$USD_DIA_RDS_C4/día C4 + \$$USD_DIA_RDS_TENANT por tenant)"
    tenue "RDS no escala a cero: la única forma de no pagarlo es destruir la instancia"
  else
    tenue "rds_persistente=false · las bases se fueron con el apagado"
  fi
  printf '\n'
  tenue "cero absoluto (destruye TODO, incluidos los datos):"
  printf '%s    terraform/scripts/destruir.sh %s%s\n\n' "$A_GRIS" "$ESCENARIO" "$A_FIN"
  exit 0
fi

# ═══ DESPLEGAR ═══════════════════════════════════════════════════════════════
case "$CLIENTES" in
  ''|*[!0-9]*) morir "--clients quiere un entero, no '$CLIENTES'" ;;
esac
[ "$CLIENTES" -ge 1 ] 2>/dev/null || morir "--clients minimo 1"
[ "$CLIENTES" -le "$MAX_CLIENTES" ] || morir "--clients maximo $MAX_CLIENTES (pediste $CLIENTES)"

# Una AZ con un solo tenant no ejercita nada: no hay reparto de carga ni
# tolerancia a fallo que probar, y la segunda AZ duplica las ENI. Con mas de
# uno, dos.
[ -n "$AZ" ] || AZ=$([ "$CLIENTES" -eq 1 ] && echo 1 || echo 2)
case "$AZ" in 1|2|3) ;; *) morir "--az acepta 1, 2 o 3" ;; esac

ANTES=$(clientes_actuales)

paso "Lo que se va a desplegar"
printf '  %-16s %s\n' "clientes" "$CLIENTES$( [ "$ANTES" != "?" ] && [ "$ANTES" != "$CLIENTES" ] && echo "  (ahora hay $ANTES)" )"
printf '  %-16s %s\n' "AZs por VPC" "$AZ"
printf '  %-16s %s\n' "por cliente" "1 RDS · 1 servicio ECS · 1 task def · 1 log group · 1 registro Cloud Map"

# El suelo, sin Fargate ni KMS. Con `awk` porque sh no hace decimales.
SUELO=$(awk -v az="$AZ" -v n="$CLIENTES" -v e="$USD_DIA_ENDPOINTS_POR_AZ" -v t="$USD_DIA_RDS_TENANT" -v c="$USD_DIA_RDS_C4" \
  'BEGIN { printf "%.2f", az*e + n*t + c }')
printf '  %-16s %s\n' "suelo encendido" "~\$$SUELO/día — endpoints + RDS, SIN Fargate ni las firmas de KMS"
tenue "el renglón dominante bajo carga es KMS: una llamada Sign POR EVENTO"

if [ "$ANTES" != "?" ] && [ "$CLIENTES" -lt "$ANTES" ]; then
  echo
  malo "BAJAS de $ANTES a $CLIENTES clientes: se DESTRUYEN $((ANTES - CLIENTES)) tenants"
  aviso "cada uno se lleva su instancia RDS, sin snapshot final:"
  aviso "lo que hubiera en ese outbox no está en ningún otro sitio."
fi

# ── Cuotas · lo que no se arregla con reintentar ────────────────────────────
CUOTAS=0
if [ "$CLIENTES" -gt 39 ]; then
  echo; aviso "RDS · $((CLIENTES + 1)) instancias (una por cliente + la de C4)."
  tenue "la cuota por defecto son 40 por región. Por encima, el apply falla a mitad."
  tenue "  aws service-quotas get-service-quota --service-code rds --quota-code L-7B6409FD"
  CUOTAS=1
fi
if [ "$CLIENTES" -ge 50 ]; then
  echo; aviso "KMS · a 2.000 ev/s son 2.000 Sign/s y la cuota por defecto es 1.000/s (ECC)."
  tenue "sin el aumento a 3.000, la prueba mide throttling en vez de arquitectura (docs/08-limites.md)"
  aviso "Fargate · ~106 tareas a 1–2 vCPU son ~150 vCPU; la cuota viene muy por debajo."
  tenue "sin el aumento, las tareas se quedan en PROVISIONING y la corrida se cancela"
  CUOTAS=1
fi
[ "$CUOTAS" = "1" ] && tenue "las cuotas se piden con DÍAS de anticipación — no son un reintento"

# ── La lista de tenants ─────────────────────────────────────────────────────
LISTA=$(awk -v n="$CLIENTES" 'BEGIN { for (i = 1; i <= n; i++) printf "%s\"%02d\"", (i > 1 ? ", " : ""), i }')

if [ "$SI" = "0" ]; then
  printf '\n  %s¿Escribir esta configuración y planificar? [s/N] %s' "$A_FUERTE" "$A_FIN"
  if [ -t 0 ]; then read -r R < /dev/tty; else R=""; fi
  case "$R" in s|S|si|SI|Si|y|Y|yes) ;; *) printf '\n  cancelado · no se tocó nada\n\n'; exit 1 ;; esac
fi

cat > "$CLIENTES_TFVARS" <<EOF
# GENERADO POR terraform:deploy — no editar a mano.
# Escrito el $(date -u '+%Y-%m-%d %H:%M UTC') con --clients $CLIENTES.
#
# Va en un .auto.tfvars y no en -var porque al aplicar un plan guardado
# OpenTofu relee los tfvars y compara: un -var de la linea de comandos da
# "Mismatch between input and plan variable value".
tenants  = [$LISTA]
az_count = $AZ
EOF
ok "clientes.auto.tfvars · $CLIENTES cliente(s), $AZ AZ"

# ── Solo el plan ────────────────────────────────────────────────────────────
if [ "$SOLO_PLAN" = "1" ]; then
  paso "Plan"
  [ -f "$PERILLA_TFVARS" ] || printf 'desired_count = 0\n' > "$PERILLA_TFVARS"
  tf init -input=false >/dev/null || morir "el init fallo"
  tf plan -input=false || morir "el plan fallo"
  printf '\n'
  tenue "no se aplicó nada · quita --plan para desplegar"
  printf '\n'; exit 0
fi

# ── Aplicar ─────────────────────────────────────────────────────────────────
# crear.sh cuando no hay nada; actualizar.sh cuando lo hay. Los dos enseñan el
# plan y piden confirmacion, y actualizar.sh ademas grita si el plan destruye.
if hay_estado; then
  paso "Actualizando a $CLIENTES cliente(s)"
  AUTO=$SI sh "$SCRIPTS/actualizar.sh" "$ESCENARIO" $([ "$SI" = "1" ] && echo --si) \
    || morir "el apply fallo · el estado puede haber quedado a medias: revisa con --estado"
else
  paso "Creando desde cero · $CLIENTES cliente(s)"
  tenue "se crea con desired_count=0: sin imágenes en ECR las tareas entrarían en"
  tenue "bucle de arranque con CannotPullContainerError, y eso no se ve como error"
  tenue "del despliegue sino como un servicio que nunca termina de arrancar."
  AUTO=$SI sh "$SCRIPTS/crear.sh" "$ESCENARIO" $([ "$SI" = "1" ] && echo --si) \
    || morir "la creación falló"
fi

# ── ¿Encender? ──────────────────────────────────────────────────────────────
# Encender sin las imagenes en ECR no da un error de despliegue: da servicios
# que reintentan para siempre. Asi que se comprueba antes de prometer nada.
TAG=$(imagen_tag); TAG=${TAG:-humo}
IMAGENES=si
REPOS=$(tf output -json ecr 2>/dev/null | jq -r '.[]' 2>/dev/null)
if [ -z "$REPOS" ]; then
  IMAGENES=no
else
  for R in $REPOS; do
    aws ecr describe-images --repository-name "${R#*/}" --image-ids imageTag="$TAG" \
      --region "$REGION" >/dev/null 2>&1 || IMAGENES=no
  done
fi

ARRANCAR=0
case "$ENCENDER" in
  si) ARRANCAR=1 ;;
  no) ARRANCAR=0 ;;
  auto) [ "$IMAGENES" = "si" ] && ARRANCAR=1 ;;
esac

if [ "$ARRANCAR" = "1" ] && [ "$IMAGENES" = "no" ]; then
  aviso "--encender con imágenes que no están en ECR (tag '$TAG'): las tareas"
  aviso "quedarán reintentando. Se enciende igual porque lo pediste."
fi

if [ "$ARRANCAR" = "1" ]; then
  paso "Encendiendo"
  tenue "recrea 12 interface endpoints (~\$$(awk -v a="$AZ" -v e="$USD_DIA_ENDPOINTS_POR_AZ" 'BEGIN{printf "%.2f", a*e}')/día con $AZ AZ). Tarda unos minutos."
  AUTO=1 sh "$SCRIPTS/encender.sh" "$ESCENARIO" || morir "el encendido falló"
fi

# ── Resumen ─────────────────────────────────────────────────────────────────
paso "Desplegado"
printf '  %-16s %s\n' "clientes" "$(clientes_actuales)"
printf '  %-16s %s\n' "desired_count" "$(perilla) $( [ "$(perilla)" = "0" ] && echo '· creado y PARADO' || echo '· corriendo' )"
printf '  %-16s %s\n' "recursos" "$(tf state list 2>/dev/null | wc -l | tr -d ' ')"
printf '\n'

if [ "$(perilla)" = "0" ]; then
  if [ "$IMAGENES" = "no" ]; then
    aviso "falta empujar las imágenes a ECR (tag '$TAG') antes de encender:"
    tenue "  terraform/docs/$ESCENARIO-referencia.md   ← el login y los repos"
  fi
  tenue "encender:  sh terraform:deploy --clients $CLIENTES --encender"
else
  tenue "los endpoints y las tareas ya están facturando"
fi
tenue "apagar:    sh terraform:deploy --down"
tenue "costo:     terraform/scripts/costos.sh dias 3     (se lee mañana)"
printf '\n'
