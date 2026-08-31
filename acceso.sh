#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# acceso — los datos vivos para llegar al despliegue.
#
#   sh acceso            los imprime
#   sh acceso --clave    incluye la contraseña de RDS en claro
#
# ── Por que existe ──────────────────────────────────────────────────────────
#
# ACCESO.md caduca. La contrasena cambia si se recrea `random_password.db`, los
# hosts de RDS si se destruyen las instancias -que es lo que pasa al apagar con
# `rds_persistente = false`- y los ids de bastion al cerrar y reabrir el acceso.
#
# Un archivo con datos caducados es peor que no tenerlo: pierdes media hora
# creyendo que algo esta roto. Esto lee el estado real y te dice si lo que
# tienes escrito sigue valiendo.
#
# La contrasena NO sale por defecto: este comando se pega en tickets y en
# capturas de pantalla.
# ─────────────────────────────────────────────────────────────────────────────
set -u

RAIZ=$(cd "$(dirname "$0")" && pwd)
ESCENARIO=${ESCENARIO:-oneClient}
DIR="$RAIZ/terraform/$ESCENARIO"
TF=${TF_BIN:-tofu}

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

CON_CLAVE=0
case "${1:-}" in
  --clave) CON_CLAVE=1 ;;
  -h|--help) sed -n '3,7p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
esac

command -v "$TF" >/dev/null 2>&1 || morir "falta $TF"
command -v aws >/dev/null 2>&1 || morir "falta la CLI de AWS"
command -v jq  >/dev/null 2>&1 || morir "falta jq"
[ -d "$DIR" ] || morir "no existe terraform/$ESCENARIO"

tf() { (cd "$DIR" && "$TF" "$@"); }
REGION=$(aws configure get region 2>/dev/null || echo us-west-2)
PREFIJO=$(grep -E '^\s*name_prefix' "$DIR/terraform.tfvars" 2>/dev/null | sed 's/.*= *"\(.*\)".*/\1/' | head -1)

printf '\n%s┌─────────────────────────────────────────────┐%s\n' "$A_FUERTE" "$A_FIN"
printf '%s│  acceso · datos vivos del despliegue         │%s\n' "$A_FUERTE" "$A_FIN"
printf '%s└─────────────────────────────────────────────┘%s\n' "$A_FUERTE" "$A_FIN"

SALIDA=$(tf output -json 2>/dev/null)
[ -n "$SALIDA" ] || morir "no hay estado aplicado en terraform/$ESCENARIO"
val() { printf '%s' "$SALIDA" | jq -r "$1 // empty" 2>/dev/null; }

paso "Despliegue"
printf '  %-16s %s\n' "cuenta" "$(aws sts get-caller-identity --query Account --output text 2>/dev/null)"
printf '  %-16s %s\n' "region" "$REGION"
printf '  %-16s %s\n' "prefijo" "$PREFIJO"
printf '  %-16s %s\n' "encendido" "$(val '.resumen.value.encendido')"
printf '  %-16s %s\n' "tenants" "$(printf '%s' "$SALIDA" | jq -r '.resumen.value.tenants | join(", ")' 2>/dev/null)"

paso "Bastiones"
BC3=$(val '.bastiones.value.c3'); BC4=$(val '.bastiones.value.c4')
if [ -z "$BC3" ] && [ -z "$BC4" ]; then
  aviso "no hay · abrir con:  sh terraform:deploy --acceso-externo"
  tenue "sin ellos no hay tuneles: las VPC no tienen ruta de entrada"
else
  printf '  %-16s %s\n' "c3" "${BC3:-—}"
  printf '  %-16s %s\n' "c4" "${BC4:-—}"
  # Registrado en SSM no es lo mismo que existir: una instancia puede estar
  # corriendo y su agente sin conectar, y entonces el tunel falla con
  # "TargetNotConnected", que no dice que el problema es el agente.
  for _i in $BC3 $BC4; do
    _p=$(aws ssm describe-instance-information --region "$REGION" \
      --filters "Key=InstanceIds,Values=$_i" \
      --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null)
    case "${_p:-}" in
      Online) ok "$_i · SSM Online" ;;
      *)      aviso "$_i · SSM ${_p:-sin registrar} — el tunel dara TargetNotConnected" ;;
    esac
  done
fi

paso "Bases de datos"
DB1=$(val '.db_endpoints.value.tenants["01"]'); DBC4=$(val '.db_endpoints.value.c4')
if [ -z "$DB1" ] && [ -z "$DBC4" ]; then
  aviso "no existen · el despliegue esta apagado y rds_persistente=false las borro"
  tenue "encender:  sh terraform:deploy --clients 1 --encender"
else
  printf '  %-16s %s\n' "tenant-01" "${DB1:-—}"
  printf '  %-16s %s\n' "c4" "${DBC4:-—}"
  printf '  %-16s %s\n' "base / usuario" "poc / app"
  printf '  %-16s %s\n' "ssl" "obligatorio, sin verificar CA (sslmode=no-verify)"
  if [ "$CON_CLAVE" = "1" ]; then
    CLAVE=$(aws secretsmanager get-secret-value --secret-id "$PREFIJO-db-password" \
      --region "$REGION" --query SecretString --output text 2>/dev/null)
    printf '  %-16s %s\n' "contrasena" "${CLAVE:-— no pude leerla}"
  else
    tenue "contrasena: sh acceso --clave   (o: aws secretsmanager get-secret-value"
    tenue "            --secret-id $PREFIJO-db-password --query SecretString --output text)"
  fi
fi

paso "Colas"
printf '  %-16s %s\n' "despliegue" "$(val '.cola_url.value')"
printf '  %-16s %s\n' "local" "$(val '.cola_local_url.value')"
aviso "son DOS a proposito: con una sola, tu C4 y el de Fargate se reparten los mensajes"

paso "Como entrar"
if [ -n "$BC3" ] || [ -n "$BC4" ]; then
  tenue "sh tunel --lista                    los puertos"
  tenue "sh tunel orq --fondo                orquestador en localhost:9090"
  tenue "sh sql db 01 --resumen              el outbox del tenant"
  tenue "sh sql c4 --resumen                 el inbox de C4"
  tenue "sh tunel --cerrar                   cerrar los tuneles"
else
  tenue "sh terraform:deploy --acceso-externo    crea los bastiones (~\$0,48/dia)"
fi
printf '\n'
