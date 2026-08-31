#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# start — levanta la PoC completa en local y comprueba que de verdad quedó viva.
#
#   sh start              verifica y arranca SOLO lo que falte
#   sh start --reiniciar  baja todo y vuelve a levantarlo
#   sh start --parar      baja todo
#   sh start --estado     dice qué hay arriba
#   sh start --sin-build  no recompila (arranca lo que ya está en dist/)
#
# Levanta cuatro procesos y una base:
#
#   cw-postgres  127.0.0.1:5433   rpf_c3_tenant01 · rpf_c3_tenant02 · rpf_c4
#   c3 tenant-01 :3001            → rpf_c3_tenant01
#   c3 tenant-02 :3002            → rpf_c3_tenant02
#   c4 consumidor :3003           → rpf_c4          [worker de la cola FIFO]
#   orquestador  :3000            → arnés de carga
#
# LO PRIMERO ES VERIFICAR. Si los cuatro ya contestan, el script no compila, no
# toca la base y no arranca nada: informa y sale. Solo si falta alguno hace
# trabajo, y únicamente el trabajo de los que faltan — compilar de más reinicia
# relojes y tira medio minuto por servicio que ya estaba bien.
#
# «Contestar» no es «tener el proceso vivo». Los cuatro responden `GET /health`
# con `ok:true`, y ese `ok` sale de una consulta real a la base: es la prueba de
# que Postgres es alcanzable DESDE la aplicación, que es la única alcanzabilidad
# que importa. Un pid vivo solo dice que el proceso existe, y un puerto abierto,
# que alguien hizo listen.
#
# C4 sigue siendo un worker —la cola es su entrada y el Postgres su salida—;
# en el 3003 solo publica su salud y el Swagger que la documenta (G-09).
# ─────────────────────────────────────────────────────────────────────────────
set -u

RAIZ=$(cd "$(dirname "$0")" && pwd)
cd "$RAIZ" || exit 1

# ── configuración · todo se puede pisar por entorno ─────────────────────────
PG_CONTENEDOR=${PG_CONTENEDOR:-cw-postgres}
PG_IMAGEN=${PG_IMAGEN:-postgres:16-alpine}
PG_HOST=${PG_HOST:-127.0.0.1}
PG_PUERTO=${PG_PUERTO:-5433}
PG_USUARIO=${PG_USUARIO:-cw}
PG_CLAVE=${PG_CLAVE:-cwlocal}
# Una base por tenant y una para C4. NO es preferencia de orden: C3 y C4 son
# dominios sin ruta de red entre ellos (D-03). Si compartieran base, conciliar
# con un JOIN pasaría en local y sería imposible en AWS.
BASES=${BASES:-"rpf_c3_tenant01 rpf_c3_tenant02 rpf_c4"}

PUERTO_C3_1=${PUERTO_C3_1:-3001}
PUERTO_C3_2=${PUERTO_C3_2:-3002}
PUERTO_ORQ=${PUERTO_ORQ:-3000}
PUERTO_C4=${PUERTO_C4:-3003}
ESPERA=${ESPERA:-90}          # segundos máximos que se espera a cada servicio

LOGS="$RAIZ/logs"
PIDS="$LOGS/pids"

# ── salida ──────────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  A_ROJO=$(printf '\033[31m'); A_VERDE=$(printf '\033[32m')
  A_AMBAR=$(printf '\033[33m'); A_GRIS=$(printf '\033[90m')
  A_FUERTE=$(printf '\033[1m'); A_FIN=$(printf '\033[0m')
else
  A_ROJO=''; A_VERDE=''; A_AMBAR=''; A_GRIS=''; A_FUERTE=''; A_FIN=''
fi

paso()   { printf '\n%s▸ %s%s\n' "$A_FUERTE" "$*" "$A_FIN"; }
ok()     { printf '  %s✔%s %s\n' "$A_VERDE" "$A_FIN" "$*"; }
aviso()  { printf '  %s!%s %s\n' "$A_AMBAR" "$A_FIN" "$*"; }
malo()   { printf '  %s✘%s %s\n' "$A_ROJO" "$A_FIN" "$*"; }
tenue()  { printf '  %s%s%s\n' "$A_GRIS" "$*" "$A_FIN"; }
morir()  { printf '\n%s✘ %s%s\n\n' "$A_ROJO" "$*" "$A_FIN"; exit 1; }

# ── utilidades ──────────────────────────────────────────────────────────────
hay()            { command -v "$1" >/dev/null 2>&1; }
puerto_abierto() { nc -z "$PG_HOST" "$1" >/dev/null 2>&1; }
vivo()           { kill -0 "$1" 2>/dev/null; }
pid_de()         { [ -f "$PIDS/$1.pid" ] && cat "$PIDS/$1.pid"; }

# Matar el pid de npm deja huérfano al node que lanzó, y ese node sigue con el
# puerto tomado: el siguiente arranque falla con EADDRINUSE y la causa no se ve
# por ningún lado. Se baja el árbol entero, de las hojas al tronco.
matar_arbol() {
  _p=$1
  for _h in $(pgrep -P "$_p" 2>/dev/null); do matar_arbol "$_h"; done
  kill "$_p" 2>/dev/null
}

psql_() { docker exec -e PGPASSWORD="$PG_CLAVE" "$PG_CONTENEDOR" psql -U "$PG_USUARIO" "$@"; }

# ─────────────────────────────────────────────────────────────────────────────
# El inventario. Una línea por servicio:
#   nombre | carpeta | script npm | puerto ('-' si no escucha) | señal de vida
#
# El orquestador va último: arranca vacío y esperando, pero no tiene sentido
# ofrecerle carga a tenants que todavía no contestan.
#
# ⚠ Los `printf` que recorren esto llevan '%s\n': `read` DESCARTA la última
# línea si no termina en salto, y el servicio de abajo desaparecería del
# arranque sin dar error.
# ─────────────────────────────────────────────────────────────────────────────
SERVICIOS="c3-tenant01|c3|start|$PUERTO_C3_1|http
c3-tenant02|c3|start:2|$PUERTO_C3_2|http
c4-consumidor|c4|start|$PUERTO_C4|http
orquestador|orquestador|start|$PUERTO_ORQ|http"

# ¿Este servicio está dando servicio AHORA MISMO? Sin esperas: es una pregunta,
# no una espera. Devuelve 0 si sí.
#
# Desde que C4 tiene `/health` (G-09) los cuatro se preguntan igual. Antes su
# señal era el marcador del log, y eso tenía un filo: con el log rotado la
# respuesta habría sido «no está» y se habría arrancado un SEGUNDO consumidor
# sobre la misma cola.
responde() {
  _n=$1; _p=$2; _s=$3
  case "$_s" in
    http)
      _r=$(curl -fsS --max-time 3 "http://localhost:$_p/health" 2>/dev/null) || return 1
      case "$_r" in *'"ok":true'*) return 0 ;; esac
      return 1
      ;;
  esac
  return 1
}

# ═══ PARAR ═══════════════════════════════════════════════════════════════════
parar_todo() {
  paso "Bajando la PoC"
  _algo=0
  # Al revés que al arrancar: primero deja de entrar carga, después se apagan
  # los que la procesan.
  for _n in orquestador c4-consumidor c3-tenant02 c3-tenant01; do
    _f="$PIDS/$_n.pid"
    [ -f "$_f" ] || continue
    _pid=$(cat "$_f")
    if vivo "$_pid"; then
      # SIGTERM, no SIGKILL: C3 y C4 tienen cierre ordenado (C-07). Matarlos a
      # lo bruto deja mensajes ya procesados sin borrar de la cola.
      matar_arbol "$_pid"
      _i=0
      while vivo "$_pid" && [ "$_i" -lt 15 ]; do sleep 1; _i=$((_i + 1)); done
      vivo "$_pid" && kill -9 "$_pid" 2>/dev/null
      ok "$_n detenido"
      _algo=1
    fi
    rm -f "$_f"
  done
  # Restos de una corrida anterior que se quedaron con el puerto tomado.
  for _p in "$PUERTO_ORQ" "$PUERTO_C3_1" "$PUERTO_C3_2" "$PUERTO_C4"; do
    _z=$(lsof -ti "tcp:$_p" -sTCP:LISTEN 2>/dev/null)
    [ -n "$_z" ] && { kill $_z 2>/dev/null; aviso "puerto $_p liberado a la fuerza"; _algo=1; }
  done
  [ "$_algo" -eq 0 ] && tenue "no había nada arriba"
  tenue "el Postgres ($PG_CONTENEDOR) se deja corriendo · docker stop $PG_CONTENEDOR"
  printf '\n'
}

# ═══ ESTADO ══════════════════════════════════════════════════════════════════
estado() {
  paso "Postgres"
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$PG_CONTENEDOR"; then
    ok "$PG_CONTENEDOR arriba · $PG_HOST:$PG_PUERTO"
  else
    malo "$PG_CONTENEDOR no está corriendo"
  fi
  paso "Servicios"
  printf '%s\n' "$SERVICIOS" | while IFS='|' read -r nom dir scr puerto senal; do
    if responde "$nom" "$puerto" "$senal"; then
      ok "$nom · responde en :$puerto$( _p=$(pid_de "$nom"); [ -n "$_p" ] && echo " · pid $_p" )"
    else
      tenue "$nom · abajo"
    fi
  done
  printf '\n'
}

# ═══ RESUMEN ═════════════════════════════════════════════════════════════════
resumen() {
  printf '  %-14s %s\n' "postgres"      "$PG_HOST:$PG_PUERTO · $BASES"
  printf '  %-14s %s\n' "c3 tenant-01"  "http://localhost:$PUERTO_C3_1/docs   → rpf_c3_tenant01"
  printf '  %-14s %s\n' "c3 tenant-02"  "http://localhost:$PUERTO_C3_2/docs   → rpf_c3_tenant02"
  printf '  %-14s %s\n' "c4"            "http://localhost:$PUERTO_C4/docs   → rpf_c4"
  printf '  %-14s %s\n' "orquestador"   "http://localhost:$PUERTO_ORQ/docs   → arnés de carga"
  printf '\n'
  tenue "logs    · tail -f logs/*.log"
  tenue "estado  · sh start --estado"
  tenue "parar   · sh start --parar"
  printf '\n'
  tenue "una corrida de prueba:"
  printf '%s    curl -X POST localhost:%s/batch -H '"'"'content-type: application/json'"'"' \\\n' "$A_GRIS" "$PUERTO_ORQ"
  printf '      -d '"'"'{"id":"xx01","client":"all","seconds":20,'
  printf '"request":{"client":{"min":20,"max":80}},"events":{"client":{"min":1,"max":10}}}'"'"'\n'
  printf '    curl localhost:%s/batch/xx01%s\n\n' "$PUERTO_ORQ" "$A_FIN"
}

# ═══ ARGUMENTOS ══════════════════════════════════════════════════════════════
SIN_BUILD=0
case "${1:-}" in
  --parar|--stop|parar|stop)        parar_todo; exit 0 ;;
  --estado|--status|estado|status)  estado; exit 0 ;;
  --reiniciar|--restart|reiniciar)  parar_todo ;;
  --sin-build)                      SIN_BUILD=1 ;;
  '')                               ;;
  *) morir "opción desconocida: $1 · usa --reiniciar | --parar | --estado | --sin-build" ;;
esac

mkdir -p "$PIDS"

# Silencioso a propósito: si todo está arriba, esto no tiene por qué salir en
# pantalla. Solo grita cuando falta algo.
for _h in node npm docker curl nc lsof pgrep; do
  hay "$_h" || morir "falta '$_h' en el PATH"
done

# ═══ VERIFICAR PRIMERO ═══════════════════════════════════════════════════════
# Antes de tocar nada: quién está dando servicio y quién no.
paso "Verificación"
: > "$LOGS/.faltan"
printf '%s\n' "$SERVICIOS" | while IFS='|' read -r nom dir scr puerto senal; do
  if responde "$nom" "$puerto" "$senal"; then
    case "$nom" in
      c3-*)          ok "$nom · /health ok:true · ve su base" ;;
      orquestador)   ok "$nom · /health ok:true · esperando batches" ;;
      c4-consumidor) ok "$nom · /health ok:true · ve su base y su cola" ;;
    esac
  else
    malo "$nom · abajo"
    printf '%s|%s|%s|%s|%s\n' "$nom" "$dir" "$scr" "$puerto" "$senal" >> "$LOGS/.faltan"
  fi
done

if [ ! -s "$LOGS/.faltan" ]; then
  rm -f "$LOGS/.faltan"
  # El `ok:true` de los dos C3 ya consultó Postgres. Volver a preguntárselo a
  # Docker no añadiría nada que no sepamos.
  paso "Todo arriba · nada que hacer"
  tenue "la base quedó verificada por el /health de los dos C3"
  printf '\n'
  resumen
  exit 0
fi

FALTAN=$(cat "$LOGS/.faltan")
rm -f "$LOGS/.faltan"
tenue "$(printf '%s\n' "$FALTAN" | wc -l | tr -d ' ') servicio(s) por levantar · el resto se deja como está"

# ═══ ENTORNO ═════════════════════════════════════════════════════════════════
# `node --env-file=.env` no arranca si el archivo no existe, y el error sale
# enterrado en el log de un proceso en segundo plano. Mejor pararlo aquí.
paso "Entorno"
for _d in c3 c4; do
  printf '%s\n' "$FALTAN" | grep -q "|$_d|" || continue
  if [ -f "$RAIZ/$_d/.env" ]; then
    ok "$_d/.env"
  elif [ -f "$RAIZ/$_d/.env.ejemplo" ]; then
    morir "falta $_d/.env — cópialo de la plantilla:  cp $_d/.env.ejemplo $_d/.env"
  else
    morir "falta $_d/.env"
  fi
done

# Aviso, no error: C3 y C4 sí necesitan credenciales para KMS y SQS, pero el
# orquestador y la base funcionan sin ellas y a veces es justo lo que se quiere
# probar. Sin credenciales, C3 acepta documentos y el outbox se llena sin salir.
if [ -n "${AWS_ACCESS_KEY_ID:-}" ] || [ -n "${AWS_PROFILE:-}" ] || [ -f "$HOME/.aws/credentials" ]; then
  ok "credenciales AWS presentes${AWS_PROFILE:+ · perfil $AWS_PROFILE}"
else
  aviso "sin credenciales AWS visibles — C3 no podrá firmar/cifrar ni publicar a SQS, y C4 no consumirá"
fi

# ═══ POSTGRES ════════════════════════════════════════════════════════════════
paso "Postgres"
docker info >/dev/null 2>&1 || morir "el demonio de Docker no responde — abre Docker Desktop"

if docker ps --format '{{.Names}}' | grep -qx "$PG_CONTENEDOR"; then
  ok "contenedor $PG_CONTENEDOR ya estaba arriba"
elif docker ps -a --format '{{.Names}}' | grep -qx "$PG_CONTENEDOR"; then
  docker start "$PG_CONTENEDOR" >/dev/null 2>&1 || morir "no se pudo arrancar $PG_CONTENEDOR"
  ok "contenedor $PG_CONTENEDOR arrancado"
else
  malo "no existe el contenedor $PG_CONTENEDOR. Créalo con:"
  printf '\n    docker run -d --name %s -p %s:%s:5432 \\\n      -e POSTGRES_USER=%s -e POSTGRES_PASSWORD=%s %s\n\n' \
    "$PG_CONTENEDOR" "$PG_HOST" "$PG_PUERTO" "$PG_USUARIO" "$PG_CLAVE" "$PG_IMAGEN"
  exit 1
fi

# Tres comprobaciones distintas, y ninguna sobra: el contenedor puede estar
# «Up» con el postmaster todavía arrancando, y puede aceptar conexiones dentro
# del contenedor sin que el puerto esté publicado hacia el host.
_i=0
until docker exec "$PG_CONTENEDOR" pg_isready -U "$PG_USUARIO" -q >/dev/null 2>&1; do
  _i=$((_i + 1))
  [ "$_i" -ge 30 ] && morir "Postgres no acepta conexiones tras 30s · docker logs $PG_CONTENEDOR"
  sleep 1
done
ok "postmaster listo (pg_isready)"

_i=0
until puerto_abierto "$PG_PUERTO"; do
  _i=$((_i + 1))
  [ "$_i" -ge 15 ] && morir "$PG_HOST:$PG_PUERTO no es alcanzable desde el host — ¿está publicado el puerto?"
  sleep 1
done
ok "$PG_HOST:$PG_PUERTO alcanzable desde el host"

# Las bases NO se crean solas. El esquema sí (bd/esquema.ts se aplica en el
# arranque y es idempotente), pero `CREATE DATABASE` no lo hace nadie: sin esto
# el servicio muere con «database does not exist» dentro de su log.
for _b in $BASES; do
  if psql_ -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$_b'" 2>/dev/null | grep -q 1; then
    _n=$(psql_ -d "$_b" -tAc "SELECT 1" 2>/dev/null | tr -d ' \n')
    [ "$_n" = "1" ] || morir "la base $_b existe pero no responde a un SELECT 1"
    ok "base $_b · responde"
  else
    if psql_ -d postgres -c "CREATE DATABASE \"$_b\"" >/dev/null 2>&1; then
      ok "base $_b · creada"
    else
      morir "no se pudo crear la base $_b"
    fi
  fi
done

# ═══ COMPILACIÓN ═════════════════════════════════════════════════════════════
# Solo las carpetas de los que faltan. Los dos C3 comparten carpeta: se compila
# una vez.
paso "Compilación"
if [ "$SIN_BUILD" -eq 1 ]; then
  aviso "--sin-build · se arranca lo que haya en dist/"
else
  CARPETAS=""
  for _d in $(printf '%s\n' "$FALTAN" | cut -d'|' -f2); do
    case " $CARPETAS " in *" $_d "*) ;; *) CARPETAS="$CARPETAS $_d" ;; esac
  done
  for _d in $CARPETAS; do
    [ -d "$RAIZ/$_d/node_modules" ] || morir "falta $_d/node_modules — corre:  cd $_d && npm ci"
    if (cd "$RAIZ/$_d" && npm run build >"$LOGS/build-$_d.log" 2>&1); then
      ok "$_d compilado"
    else
      malo "$_d NO compila · $LOGS/build-$_d.log"
      tail -n 20 "$LOGS/build-$_d.log" | sed 's/^/      /'
      exit 1
    fi
  done
fi

# ═══ ARRANQUE ════════════════════════════════════════════════════════════════
paso "Arranque"
printf '%s\n' "$FALTAN" | while IFS='|' read -r nom dir scr puerto senal; do
  _f="$PIDS/$nom.pid"

  # Proceso vivo que no contesta: un arranque a medias, o colgado. Relanzarlo
  # encima dejaría dos procesos y el pid del viejo perdido para siempre.
  _pid=$(pid_de "$nom")
  if [ -n "$_pid" ] && vivo "$_pid"; then
    aviso "$nom · el proceso $_pid vive pero no contesta · se reemplaza"
    matar_arbol "$_pid"
    sleep 2
  fi
  if [ "$puerto" != '-' ] && puerto_abierto "$puerto"; then
    aviso "$nom · el puerto $puerto está ocupado por otro proceso · no se arranca"
    tenue "libéralo con:  sh start --parar"
    continue
  fi

  # nohup + </dev/null: sin eso los cuatro cuelgan de la terminal que los lanzó
  # y se van con ella al cerrarla — una corrida de veinte minutos no puede
  # depender de que nadie toque esa ventana.
  # --ignore-scripts salta el prestart: ya se compiló arriba, una sola vez.
  ( cd "$RAIZ/$dir" && exec nohup npm run "$scr" --ignore-scripts ) </dev/null >"$LOGS/$nom.log" 2>&1 &
  echo $! > "$_f"
  tenue "$nom lanzado (pid $(cat "$_f")) · $LOGS/$nom.log"
done

# ═══ COMPROBACIÓN FINAL ══════════════════════════════════════════════════════
# Un proceso vivo no es un servicio listo. Aquí sí se espera a la señal real de
# cada uno, y para C3 y el orquestador esa señal incluye una consulta a la base.
paso "Comprobación"
FALLOS=0
printf '%s\n' "$FALTAN" > "$LOGS/.pendientes"

while IFS='|' read -r nom dir scr puerto senal; do
  _f="$PIDS/$nom.pid"
  [ -f "$_f" ] || { malo "$nom · no arrancó"; FALLOS=$((FALLOS + 1)); continue; }
  _pid=$(cat "$_f")
  _log="$LOGS/$nom.log"
  _i=0; _listo=0

  while [ "$_i" -lt "$ESPERA" ]; do
    if ! vivo "$_pid"; then
      malo "$nom · el proceso murió"
      tail -n 15 "$_log" | sed 's/^/      /'
      rm -f "$_f"
      break
    fi
    case "$senal" in
      http)
        _r=$(curl -fsS --max-time 3 "http://localhost:$puerto/health" 2>/dev/null)
        case "$_r" in
          *'"ok":true'*)  _listo=1 ;;
          *'"ok":false'*) _listo=2 ;;   # vivo pero la base no le contesta
        esac
        ;;
    esac
    [ "$_listo" -ne 0 ] && break
    _i=$((_i + 1)); sleep 1
  done

  case "$_listo" in
    1) case "$nom" in
         c3-*)          ok "$nom · /health ok:true · ve su base" ;;
         orquestador)   ok "$nom · /health ok:true · esperando batches" ;;
         c4-consumidor) ok "$nom · /health ok:true · ve su base y su cola" ;;
       esac ;;
    2) malo "$nom · contesta, pero /health dice ok:false — no ve su base"
       FALLOS=$((FALLOS + 1)) ;;
    0) if vivo "$_pid"; then
         malo "$nom · sigue vivo pero no dio señal en ${ESPERA}s · $_log"
       fi
       FALLOS=$((FALLOS + 1)) ;;
  esac
done < "$LOGS/.pendientes"
rm -f "$LOGS/.pendientes"

paso "Listo"
resumen

if [ "$FALLOS" -gt 0 ]; then
  printf '%s✘ %s servicio(s) no quedaron listos — mira sus logs antes de medir nada.%s\n\n' "$A_ROJO" "$FALLOS" "$A_FIN"
  exit 1
fi
exit 0
