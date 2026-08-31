#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# tunel — abre un puerto del despliegue en tu localhost, por el bastion.
#
#   sh tunel --lista            que hay y en que puerto local queda
#   sh tunel orq                orquestador   → localhost:9090
#   sh tunel api 01             API de C3     → localhost:18001
#   sh tunel db 01              RDS tenant-01 → localhost:15401
#   sh tunel c4                 health de C4  → localhost:13003
#   sh tunel c4db               RDS de C4     → localhost:15499
#
#   --fondo      lo abre en segundo plano y devuelve el prompt
#   sh tunel --cerrar            cierra todos los de segundo plano
#   sh tunel --instalar-plugin   session-manager-plugin en .bin/, sin sudo
#
#   --puerto N   forzar el puerto local
#
# ── Como funciona ───────────────────────────────────────────────────────────
#
# Session Manager con el documento AWS-StartPortForwardingSessionToRemoteHost.
# El `host` lo resuelve EL BASTION, no tu maquina: por eso valen los nombres de
# Cloud Map (api-01.poc.local, orq.poc.local) y los endpoints de RDS, que son
# privados. Desde aqui es localhost y ahi funcionan curl, Postman, psql,
# DBeaver o TablePlus.
#
# La sesion es BLOQUEANTE: se queda abierta hasta Ctrl-C. Un tunel por
# terminal.
#
# ── Los puertos locales, y por que estos ────────────────────────────────────
#
# Derivados del numero de tenant, para que con 50 clientes no haya que
# inventarse nada ni llevar una lista:
#
#   API del tenant NN   → 18000 + NN
#   RDS del tenant NN   → 15400 + NN
#   RDS de C4           → 15499   (fuera del rango de tenants, a proposito)
#   orquestador         → 9090    (el mismo que dentro)
#   health de C4        → 13003
#
# ⚠ Ni 3001 ni 3003: son los del entorno LOCAL (`sh start`). Si el tunel los
#   robara, un `curl localhost:3003` no diria si le estas pegando a tu maquina
#   o a AWS — y esa confusion ya nos costo una medicion.
# ─────────────────────────────────────────────────────────────────────────────
set -u

RAIZ=$(cd "$(dirname "$0")" && pwd)
ESCENARIO=${ESCENARIO:-oneClient}
DIR="$RAIZ/terraform/$ESCENARIO"
TF=${TF_BIN:-tofu}
BIN="$RAIZ/.bin"
TUNELES="$RAIZ/.tuneles"

# El plugin puede estar instalado en el sistema o en .bin/ (ver --instalar-plugin).
PATH="$BIN:$PATH"; export PATH

if [ -t 1 ]; then
  A_ROJO=$(printf '\033[31m'); A_VERDE=$(printf '\033[32m')
  A_AMBAR=$(printf '\033[33m'); A_GRIS=$(printf '\033[90m')
  A_FUERTE=$(printf '\033[1m'); A_FIN=$(printf '\033[0m')
else
  A_ROJO=''; A_VERDE=''; A_AMBAR=''; A_GRIS=''; A_FUERTE=''; A_FIN=''
fi
ok()    { printf '  %s✔%s %s\n' "$A_VERDE" "$A_FIN" "$*"; }
aviso() { printf '  %s!%s %s\n' "$A_AMBAR" "$A_FIN" "$*"; }
tenue() { printf '  %s%s%s\n' "$A_GRIS" "$*" "$A_FIN"; }
morir() { printf '\n%s✘ %s%s\n\n' "$A_ROJO" "$*" "$A_FIN"; exit 1; }

tf() { (cd "$DIR" && "$TF" "$@"); }

# ── Instalar el plugin sin sudo ─────────────────────────────────────────────
#
# `brew install --cask session-manager-plugin` corre un `installer -pkg` que
# pide sudo CON TERMINAL: desde un script falla con "a terminal is required to
# read the password" y deja el cask a medias.
#
# El .pkg oficial de AWS se puede desempaquetar sin permisos: dentro solo hay un
# binario estatico. Se deja en .bin/ (gitignored) y este script lo pone en PATH.
instalar_plugin() {
  printf '\n%s▸ session-manager-plugin%s\n' "$A_FUERTE" "$A_FIN"
  command -v session-manager-plugin >/dev/null 2>&1 && {
    ok "ya esta: $(session-manager-plugin --version 2>/dev/null)"
    printf '\n'; return 0
  }
  case "$(uname -m)" in
    arm64|aarch64) _arq=mac_arm64 ;;
    *)             _arq=mac ;;
  esac
  _tmp=$(mktemp -d) || morir "no pude crear un temporal"
  tenue "descargando el .pkg oficial de AWS ($_arq)"
  curl -fsS -o "$_tmp/smp.pkg" \
    "https://s3.amazonaws.com/session-manager-downloads/plugin/latest/$_arq/session-manager-plugin.pkg" \
    || morir "no pude descargar el plugin"
  (cd "$_tmp" && pkgutil --expand-full smp.pkg expandido >/dev/null 2>&1) \
    || morir "no pude desempaquetar el .pkg"
  _bin=$(find "$_tmp/expandido" -type f -name 'session-manager-plugin' | head -1)
  [ -n "$_bin" ] || morir "el .pkg no traia el binario donde se esperaba"
  mkdir -p "$BIN" && cp "$_bin" "$BIN/" && chmod +x "$BIN/session-manager-plugin"
  rm -rf "$_tmp"
  ok "instalado en .bin/ · $("$BIN/session-manager-plugin" --version 2>/dev/null)"
  tenue "para tenerlo en todo el sistema:  brew install --cask session-manager-plugin"
  printf '\n'
}

# ── Verificar antes de actuar ───────────────────────────────────────────────
command -v aws >/dev/null 2>&1 || morir "falta la CLI de AWS"
command -v jq  >/dev/null 2>&1 || morir "falta jq"

case "${1:-}" in
  --instalar-plugin) instalar_plugin; exit 0 ;;
esac

# Se instala solo la primera vez, en vez de mandarte a leer un mensaje.
command -v session-manager-plugin >/dev/null 2>&1 || instalar_plugin
command -v session-manager-plugin >/dev/null 2>&1 \
  || morir "sigue faltando session-manager-plugin · sh tunel --instalar-plugin"

[ -d "$DIR" ] || morir "no existe terraform/$ESCENARIO"

BASTIONES=$(tf output -json bastiones 2>/dev/null)
BAST_C3=$(printf '%s' "$BASTIONES" | jq -r '.c3 // empty' 2>/dev/null)
BAST_C4=$(printf '%s' "$BASTIONES" | jq -r '.c4 // empty' 2>/dev/null)

if [ -z "$BAST_C3" ] && [ -z "$BAST_C4" ]; then
  printf '\n%s✘ no hay bastiones desplegados%s\n\n' "$A_ROJO" "$A_FIN"
  tenue "abrir el acceso:  sh terraform:deploy --acceso-externo"
  tenue "cuesta ~\$0,48/dia y no expone ningun puerto"
  printf '\n'; exit 1
fi

DB_C3=$(tf output -json db_endpoints 2>/dev/null | jq -r '.tenants // {}' 2>/dev/null)
DB_C4=$(tf output -json db_endpoints 2>/dev/null | jq -r '.c4 // empty' 2>/dev/null)

# ── Argumentos ──────────────────────────────────────────────────────────────
QUE=${1:-}; [ $# -gt 0 ] && shift
NN=""; PUERTO_LOCAL=""; FONDO=0
while [ $# -gt 0 ]; do
  case "$1" in
    --puerto) PUERTO_LOCAL=${2:-}; shift 2 ;;
    --fondo|-d) FONDO=1; shift ;;
    -h|--help) sed -n '3,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) NN=$1; shift ;;
  esac
done

# ── Cerrar los que quedaron en segundo plano ────────────────────────────────
if [ "$QUE" = "--cerrar" ]; then
  printf '\n%s▸ Cerrando tuneles%s\n' "$A_FUERTE" "$A_FIN"
  _n=0

  # ⚠ MATAR EL `aws` NO CIERRA EL PUERTO.
  #
  # `aws ssm start-session` lanza `session-manager-plugin` como HIJO, y es el
  # hijo el que hace el listen. Al matar solo al padre, el plugin queda
  # huerfano y sigue aceptando conexiones contra una sesion que ya no existe:
  # el puerto responde, `nc -z` dice que esta abierto, y cualquier peticion se
  # queda colgada. Parece un tunel bueno y no lo es.
  #
  # Por eso se cierra por PUERTO -con lsof- y no solo por pid.
  cerrar_puerto() {
    case "$1" in ''|*[!0-9]*) return 0 ;; esac
    for _p in $(lsof -ti "TCP:$1" -sTCP:LISTEN 2>/dev/null); do
      kill "$_p" 2>/dev/null
    done
  }

  if [ -d "$TUNELES" ]; then
    for f in "$TUNELES"/*.pid; do
      [ -f "$f" ] || continue
      _nom=$(basename "$f" .pid)
      _pid=$(cat "$f" 2>/dev/null)
      [ -n "$_pid" ] && kill "$_pid" 2>/dev/null
      cerrar_puerto "${_nom##*-}"   # orq-9090 -> 9090
      ok "$_nom"
      _n=$((_n + 1))
      rm -f "$f"
    done
  fi

  # Barrido de huerfanos: plugins de port-forwarding contra NUESTROS bastiones
  # que quedaron sin pidfile -por un Ctrl-C a medias, o por una version vieja
  # de este script que solo mataba al padre-.
  for _b in $BAST_C3 $BAST_C4; do
    [ -n "$_b" ] || continue
    for _p in $(pgrep -f "session-manager-plugin.*$_b" 2>/dev/null); do
      kill "$_p" 2>/dev/null && { ok "huerfano (pid $_p)"; _n=$((_n + 1)); }
    done
  done

  [ "$_n" = "0" ] && tenue "no habia ninguno abierto"
  printf '\n'; exit 0
fi

# ── La lista ────────────────────────────────────────────────────────────────
if [ "$QUE" = "--lista" ] || [ "$QUE" = "" ] || [ "$QUE" = "-l" ]; then
  printf '\n%s┌─────────────────────────────────────────────┐%s\n' "$A_FUERTE" "$A_FIN"
  printf '%s│  tunel · lo que puedes abrir                 │%s\n' "$A_FUERTE" "$A_FIN"
  printf '%s└─────────────────────────────────────────────┘%s\n\n' "$A_FUERTE" "$A_FIN"

  printf '  %-22s %-14s %s\n' "COMANDO" "LOCAL" "DESTINO"
  printf '  %-22s %-14s %s\n' "sh tunel orq" "9090" "orq.poc.local:9090"
  for t in $(printf '%s' "$DB_C3" | jq -r 'keys[]' 2>/dev/null); do
    _h=$(printf '%s' "$DB_C3" | jq -r --arg k "$t" '.[$k]')
    printf '  %-22s %-14s %s\n' "sh tunel api $t" "$((18000 + $(echo "$t" | sed 's/^0*//')))" "api-$t.poc.local:8080"
    printf '  %-22s %-14s %s\n' "sh tunel db $t" "$((15400 + $(echo "$t" | sed 's/^0*//')))" "${_h%%.*}…:5432"
  done
  printf '  %-22s %-14s %s\n' "sh tunel c4" "13003" "task de C4:3003"
  printf '  %-22s %-14s %s\n' "sh tunel c4db" "15499" "${DB_C4%%.*}…:5432"

  printf '\n'
  ok "bastion c3 · ${BAST_C3:-—}"
  ok "bastion c4 · ${BAST_C4:-—}"
  printf '\n'
  tenue "cada tunel es BLOQUEANTE: uno por terminal, Ctrl-C para cerrarlo"
  tenue "la contrasena de las bases:  cat ACCESO.md"
  printf '\n'; exit 0
fi

# ── Resolver destino ────────────────────────────────────────────────────────
sin_ceros() { echo "$1" | sed 's/^0*//'; }

case "$QUE" in
  orq)
    BAST=$BAST_C3; HOST=orq.poc.local; PUERTO=9090
    : "${PUERTO_LOCAL:=9090}" ;;
  api)
    [ -n "$NN" ] || morir "que tenant? · sh tunel api 01"
    BAST=$BAST_C3; HOST="api-$NN.poc.local"; PUERTO=8080
    : "${PUERTO_LOCAL:=$((18000 + $(sin_ceros "$NN")))}" ;;
  db)
    [ -n "$NN" ] || morir "que tenant? · sh tunel db 01"
    HOST=$(printf '%s' "$DB_C3" | jq -r --arg k "$NN" '.[$k] // empty')
    [ -n "$HOST" ] || morir "el tenant '$NN' no tiene RDS · ¿esta encendido el despliegue?"
    BAST=$BAST_C3; PUERTO=5432
    : "${PUERTO_LOCAL:=$((15400 + $(sin_ceros "$NN")))}" ;;
  c4)
    BAST=$BAST_C4; PUERTO=3003
    HOST=$(aws ecs list-tasks --cluster "$(basename "$DIR" | sed 's/.*/rpf-one-c4/')" \
             --desired-status RUNNING --query 'taskArns[0]' --output text 2>/dev/null)
    [ -n "$HOST" ] && [ "$HOST" != "None" ] || morir "no hay task de C4 corriendo"
    HOST=$(aws ecs describe-tasks --cluster rpf-one-c4 --tasks "$HOST" \
             --query 'tasks[0].attachments[0].details[?name==`privateIPv4Address`].value' \
             --output text 2>/dev/null)
    [ -n "$HOST" ] || morir "no pude leer la IP de la task de C4"
    : "${PUERTO_LOCAL:=13003}" ;;
  c4db)
    [ -n "$DB_C4" ] || morir "la RDS de C4 no existe · ¿esta encendido el despliegue?"
    BAST=$BAST_C4; HOST=$DB_C4; PUERTO=5432
    : "${PUERTO_LOCAL:=15499}" ;;
  *)
    morir "no se que es '$QUE' · sh tunel --lista" ;;
esac

[ -n "${BAST:-}" ] || morir "no hay bastion en la VPC que hace falta para '$QUE'"

# ── Abrir ───────────────────────────────────────────────────────────────────
printf '\n%s▸ tunel%s  localhost:%s  →  %s:%s\n' "$A_FUERTE" "$A_FIN" "$PUERTO_LOCAL" "$HOST" "$PUERTO"
if [ "$FONDO" = "1" ]; then
  tenue "por el bastion $BAST - en segundo plano"
else
  tenue "por el bastion $BAST - Ctrl-C para cerrar"
fi
case "$QUE" in
  db|c4db) tenue "psql \"postgres://app:\$(grep -m1 -A0 'Contraseña' /dev/null 2>/dev/null)@localhost:$PUERTO_LOCAL/poc?sslmode=no-verify\"" ;;
  orq)     tenue "curl -X POST localhost:$PUERTO_LOCAL/batch -H 'content-type: application/json' -d '{\"id\":\"mi01\",\"seconds\":20,\"rate\":5}'" ;;
  api)     tenue "curl localhost:$PUERTO_LOCAL/health" ;;
  c4)      tenue "curl localhost:$PUERTO_LOCAL/status" ;;
esac
PARAMS="{\"host\":[\"$HOST\"],\"portNumber\":[\"$PUERTO\"],\"localPortNumber\":[\"$PUERTO_LOCAL\"]}"

if [ "$FONDO" = "1" ]; then
  # Un pidfile por puerto local: es lo que identifica el tunel de forma unica
  # -dos destinos no pueden compartir puerto- y lo que permite `--cerrar`.
  mkdir -p "$TUNELES"
  _nom="$QUE${NN:+-$NN}-$PUERTO_LOCAL"
  _log="$TUNELES/$_nom.log"
  nohup aws ssm start-session --target "$BAST" \
    --document-name AWS-StartPortForwardingSessionToRemoteHost \
    --parameters "$PARAMS" </dev/null >"$_log" 2>&1 &
  echo $! > "$TUNELES/$_nom.pid"

  # Esperar a que el puerto abra de verdad. Devolver el prompt antes seria
  # devolver un tunel que todavia no acepta conexiones, y el primer curl
  # fallaria con "connection refused" sin que nada estuviera roto.
  _i=0
  while [ $_i -lt 40 ]; do
    grep -q "Waiting for connections" "$_log" 2>/dev/null && break
    kill -0 "$(cat "$TUNELES/$_nom.pid")" 2>/dev/null || break
    _i=$((_i + 1)); sleep 1
  done
  if grep -q "Waiting for connections" "$_log" 2>/dev/null; then
    ok "abierto en segundo plano · pid $(cat "$TUNELES/$_nom.pid") · log $_log"
    tenue "cerrar todos:  sh tunel --cerrar"
  else
    aviso "no confirmo la apertura en 40 s · mira $_log"
  fi
  printf '\n'
  exit 0
fi

exec aws ssm start-session \
  --target "$BAST" \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "$PARAMS"
