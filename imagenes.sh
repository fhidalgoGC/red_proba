#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# imagenes — construye las tres imagenes y las empuja a ECR.
#
#   sh imagenes                 construye y empuja las tres
#   sh imagenes c3 c4           solo esas
#   sh imagenes --solo-build    construye y no empuja
#   sh imagenes --estado        que hay en ECR ahora mismo
#
#   --tag X        etiqueta a usar (por defecto, imagen_tag de terraform.tfvars)
#   --escenario X  oneClient (por defecto) | 50client
#
# ── Por que este script existe ───────────────────────────────────────────────
#
# `terraform:deploy` NO enciende si los repos estan vacios, y hace bien: unas
# tareas con imagen inexistente no fallan el despliegue, se quedan
# reintentando con CannotPullContainerError y eso se lee como "el servicio
# tarda en arrancar". Pero hasta ahora no habia nada que llenara esos repos.
#
# ── Las dos decisiones que no son obvias ─────────────────────────────────────
#
# 1. ARM64. Es lo nativo en las maquinas donde se construye, y Fargate lo cobra
#    ~20% mas barato. Las task definitions lo declaran en `runtime_platform`:
#    si se cambia aqui hay que cambiarlo alli, o la tarea muere con
#    «exec format error» al primer arranque.
#
# 2. `--provenance=false --sbom=false`. Sin esto buildx publica un OCI index
#    con un manifiesto de atestacion de plataforma `unknown/unknown` colgando.
#    ECS lo resuelve, pero el dia que algo de la cadena no lo haga el sintoma
#    es otra vez CannotPullContainerError — y nadie va a sospechar de una
#    atestacion. Una imagen, una plataforma, un manifiesto.
# ─────────────────────────────────────────────────────────────────────────────
set -u

RAIZ=$(cd "$(dirname "$0")" && pwd)
cd "$RAIZ" || exit 1

ESCENARIO=${ESCENARIO:-oneClient}
PLATAFORMA=linux/arm64

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
tenue() { printf '  %s%s%s\n' "$A_GRIS" "$*" "$A_FIN"; }
morir() { printf '\n%s✘ %s%s\n\n' "$A_ROJO" "$*" "$A_FIN"; exit 1; }

# carpeta:repo-en-ecr — el sufijo del repo lo fija modules/registry
CARPETAS="c3 c4 orquestador"
repo_de() {
  case "$1" in
    c3)          echo c3-api ;;
    c4)          echo c4-consumer ;;
    orquestador) echo orq-driver ;;
    *)           echo "" ;;
  esac
}

TAG=""; SOLO_BUILD=0; ACCION=todo; PEDIDAS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --tag)              TAG=${2:-}; shift 2 ;;
    --escenario)        ESCENARIO=${2:-}; shift 2 ;;
    --solo-build|--no-push) SOLO_BUILD=1; shift ;;
    --estado|--status)  ACCION=estado; shift ;;
    -h|--help)          sed -n '3,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*)                 morir "opcion desconocida: $1" ;;
    *)                  [ -n "$(repo_de "$1")" ] || morir "'$1' no es c3, c4 ni orquestador"
                        PEDIDAS="$PEDIDAS $1"; shift ;;
  esac
done
[ -n "$PEDIDAS" ] || PEDIDAS=$CARPETAS

DIR="$RAIZ/terraform/$ESCENARIO"
[ -d "$DIR" ] || morir "no existe terraform/$ESCENARIO"

printf '\n%s┌─────────────────────────────────────────────┐%s\n' "$A_FUERTE" "$A_FIN"
printf '%s│  imagenes · PoC RPF Proof Ledger            │%s\n' "$A_FUERTE" "$A_FIN"
printf '%s└─────────────────────────────────────────────┘%s\n' "$A_FUERTE" "$A_FIN"

# ── VERIFICAR PRIMERO ───────────────────────────────────────────────────────
paso "Verificación"
command -v docker >/dev/null 2>&1 || morir "falta docker"
command -v aws    >/dev/null 2>&1 || morir "falta la CLI de AWS"
command -v jq     >/dev/null 2>&1 || morir "falta jq"
docker info >/dev/null 2>&1 || morir "el demonio de Docker no responde · abre Docker Desktop"

CUENTA=$(aws sts get-caller-identity --query Account --output text 2>/dev/null) \
  || morir "las credenciales de AWS no responden · aws sso login / aws configure"
REGION=$(aws configure get region 2>/dev/null || echo us-west-2)
REGISTRO="$CUENTA.dkr.ecr.$REGION.amazonaws.com"

# El prefijo sale del tfvars, no de una constante: si alguien lo cambia alli,
# este script apunta al repo equivocado y el push crea uno nuevo en silencio.
PREFIJO=$(grep -E '^\s*name_prefix' "$DIR/terraform.tfvars" 2>/dev/null | sed 's/.*= *"\(.*\)".*/\1/' | head -1)
[ -n "$PREFIJO" ] || morir "no encontre name_prefix en terraform/$ESCENARIO/terraform.tfvars"

if [ -z "$TAG" ]; then
  TAG=$(grep -E '^\s*imagen_tag' "$DIR/terraform.tfvars" 2>/dev/null | sed 's/.*= *"\(.*\)".*/\1/' | head -1)
  [ -n "$TAG" ] || morir "no encontre imagen_tag en el tfvars · pasa --tag"
fi
ok "cuenta $CUENTA · región $REGION · $PREFIJO · tag '$TAG'"

# ═══ ESTADO ══════════════════════════════════════════════════════════════════
if [ "$ACCION" = "estado" ]; then
  paso "En ECR"
  for c in $CARPETAS; do
    REPO="$PREFIJO-$(repo_de "$c")"
    LINEA=$(aws ecr describe-images --repository-name "$REPO" --region "$REGION" \
      --query 'sort_by(imageDetails,&imagePushedAt)[-1].[join(`,`,imageTags),imagePushedAt,imageSizeInBytes]' \
      --output text 2>/dev/null)
    case "${LINEA:-}" in
      ''|None*) printf '  %-14s %s\n' "$c" "${A_AMBAR}vacío${A_FIN}" ;;
      *)        printf '  %-14s %s\n' "$c" "$LINEA" ;;
    esac
  done
  printf '\n'; exit 0
fi

# ── Construir ───────────────────────────────────────────────────────────────
paso "Construyendo · $PLATAFORMA"
tenue "las task definitions declaran ARM64 en runtime_platform; si cambia una, cambian las dos"
for c in $PEDIDAS; do
  [ -f "$RAIZ/$c/Dockerfile" ] || morir "falta $c/Dockerfile"
  docker build --platform "$PLATAFORMA" --provenance=false --sbom=false \
    -t "$PREFIJO-$c:$TAG" "$RAIZ/$c" >/dev/null 2>&1 \
    || morir "el build de $c falló · repite sin >/dev/null para ver por qué"
  ok "$c → $PREFIJO-$c:$TAG"
done

if [ "$SOLO_BUILD" = "1" ]; then
  printf '\n'; tenue "--solo-build · no se empujó nada"; printf '\n'; exit 0
fi

# ── Empujar ─────────────────────────────────────────────────────────────────
paso "Empujando a ECR"
aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$REGISTRO" >/dev/null 2>&1 \
  || morir "el login de ECR falló"

for c in $PEDIDAS; do
  REPO="$PREFIJO-$(repo_de "$c")"
  # Si el repo no existe, el push lo diria con un error de autorizacion que no
  # apunta a nada. Terraform es quien crea los repos (modules/registry).
  aws ecr describe-repositories --repository-names "$REPO" --region "$REGION" >/dev/null 2>&1 \
    || morir "el repo $REPO no existe en ECR · falta el apply de terraform"

  docker tag "$PREFIJO-$c:$TAG" "$REGISTRO/$REPO:$TAG" || morir "el tag de $c falló"
  docker push "$REGISTRO/$REPO:$TAG" >/dev/null 2>&1 || morir "el push de $c falló"

  DIGEST=$(aws ecr describe-images --repository-name "$REPO" --region "$REGION" \
    --image-ids imageTag="$TAG" --query 'imageDetails[0].imageDigest' --output text 2>/dev/null)
  ok "$REPO:$TAG · ${DIGEST#sha256:}"
done

paso "Listo"
tenue "encender:  sh terraform:deploy --clients 1 --encender"
tenue "una imagen nueva NO reinicia las tareas: sh terraform:deploy --down && ... --encender"
printf '\n'
