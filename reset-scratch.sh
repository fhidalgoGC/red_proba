#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# reset-scratch — deja la PoC como recién clonada: sin datos y sin logs.
#
#   sh reset-scratch        muestra qué va a borrar y pide confirmación
#   sh reset-scratch -y     borra sin preguntar
#   sh reset-scratch --solo-bd    solo vacía las bases
#   sh reset-scratch --solo-logs  solo borra logs y salidas
#
# Borra:
#   · TODAS las filas de rpf_c3_tenant01, rpf_c3_tenant02 y rpf_c4
#   · logs/            (logs de arranque, de compilación y los pids)
#   · c3/logs · c4/logs · orquestador/logs
#   · orquestador/salida/   ← el manifiesto de expedientes
#
# El manifiesto se va con lo demás a propósito: si se vacía el inbox de C4 y
# queda el manifiesto de la corrida anterior, `conciliar` cruza uno viejo
# contra un inbox vacío y dice que faltan TODOS los eventos — un falso negativo
# de P4. Con `--sin-salida` se conserva.
#
# ⚠ EXCEPCIÓN · orquestador/salida/plantillas/ NO se borra.
#   El manifiesto es SALIDA de una corrida; las plantillas son ENTRADA fija.
#   El pool se deriva de `pool.semilla` y no cambia entre corridas: borrarlo
#   obligaba a volver a lanzar `npm run volcar` sin que nada lo dijera, y quien
#   abría la carpeta para inspeccionar un payload no encontraba nada. Es dato
#   de referencia, no residuo de la prueba.
#
# NO borra: dist/, node_modules/, los .env, ni el esquema de las bases (las
# tablas se vacían, no se tiran: el esquema lo recrea cada servicio al arrancar
# y tirarlo aquí solo añadiría una forma más de que el arranque falle).
#
# NO toca la cola SQS. Está en AWS y purgarla es una decisión tuya: si quedaron
# mensajes de la corrida anterior, C4 los volverá a insertar al arrancar y los
# números de la siguiente corrida saldrán inflados — el script te recuerda el
# comando al final.
#
# La cola local (`rpf-one-local-eventos.fifo`) es OTRA que la del despliegue, y
# eso no es comodidad: con una sola, tu C4 y el de Fargate compiten por los
# mismos mensajes y cada uno se lleva la mitad, sin un error y con P4 dando de
# menos. La crea Terraform; sale en `tofu output cola_local_url`.
# ─────────────────────────────────────────────────────────────────────────────
set -u

RAIZ=$(cd "$(dirname "$0")" && pwd)
cd "$RAIZ" || exit 1

PG_CONTENEDOR=${PG_CONTENEDOR:-cw-postgres}
PG_HOST=${PG_HOST:-127.0.0.1}
PG_PUERTO=${PG_PUERTO:-5433}
PG_USUARIO=${PG_USUARIO:-cw}
PG_CLAVE=${PG_CLAVE:-cwlocal}
BASES=${BASES:-"rpf_c3_tenant01 rpf_c3_tenant02 rpf_c4"}

PUERTO_C3_1=${PUERTO_C3_1:-3001}
PUERTO_C3_2=${PUERTO_C3_2:-3002}
PUERTO_ORQ=${PUERTO_ORQ:-3000}
PUERTO_C4=${PUERTO_C4:-3003}

LOGS="$RAIZ/logs"
# Todo lo que se borra del disco. Se vacía el contenido, no el directorio:
# borrar la carpeta cambiaría permisos y rompería el .gitignore de cada track.
CARPETAS="logs c3/logs c4/logs orquestador/logs orquestador/salida"
# Rutas que sobreviven al borrado aunque caigan dentro de CARPETAS. El pool de
# plantillas es entrada reproducible de la prueba, no salida suya.
NO_BORRAR='*/plantillas*'

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

psql_() { docker exec -e PGPASSWORD="$PG_CLAVE" "$PG_CONTENEDOR" psql -U "$PG_USUARIO" "$@"; }

# Las tablas no se listan a mano: se preguntan. Una tabla nueva en esquema.ts
# quedaría con datos viejos y nadie se enteraría hasta ver un número raro.
TABLAS_SQL="SELECT string_agg(format('%I.%I', table_schema, table_name), ', ')
            FROM information_schema.tables
            WHERE table_type='BASE TABLE'
              AND table_schema NOT IN ('pg_catalog','information_schema')"

# Un solo viaje por base para contar todas sus tablas.
CONTEO_SQL="SELECT table_schema||'.'||table_name || ' ' ||
              (xpath('/row/c/text()', query_to_xml(
                 format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name),
                 false, true, '')))[1]::text
            FROM information_schema.tables
            WHERE table_type='BASE TABLE'
              AND table_schema NOT IN ('pg_catalog','information_schema')
            ORDER BY 1"

SI=0; SOLO_BD=0; SOLO_LOGS=0
for _a in "$@"; do
  case "$_a" in
    -y|--si|--yes)  SI=1 ;;
    --solo-bd)      SOLO_BD=1 ;;
    --solo-logs)    SOLO_LOGS=1 ;;
    --sin-salida)   CARPETAS=$(printf '%s' "$CARPETAS" | sed 's#orquestador/salida##') ;;
    *) morir "opción desconocida: $_a · usa -y | --solo-bd | --solo-logs | --sin-salida" ;;
  esac
done

printf '\n%s┌─────────────────────────────────────────────┐%s\n' "$A_FUERTE" "$A_FIN"
printf '%s│  reset-scratch · la PoC vuelve a cero       │%s\n' "$A_FUERTE" "$A_FIN"
printf '%s└─────────────────────────────────────────────┘%s\n' "$A_FUERTE" "$A_FIN"

# ═══ QUÉ HAY ═════════════════════════════════════════════════════════════════
FILAS=0
if [ "$SOLO_LOGS" -eq 0 ]; then
  paso "Datos"
  command -v docker >/dev/null 2>&1 || morir "falta 'docker' en el PATH"
  docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$PG_CONTENEDOR" \
    || morir "el contenedor $PG_CONTENEDOR no está corriendo · arráncalo con:  sh start"

  for _b in $BASES; do
    if ! psql_ -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$_b'" 2>/dev/null | grep -q 1; then
      tenue "$_b · no existe todavía · nada que borrar"
      continue
    fi
    _det=$(psql_ -d "$_b" -tAc "$CONTEO_SQL" 2>/dev/null)
    [ -z "$_det" ] && { tenue "$_b · sin tablas"; continue; }
    _sub=$(printf '%s\n' "$_det" | awk '{s+=$2} END {print s+0}')
    FILAS=$((FILAS + _sub))
    printf '  %s%-18s %6s filas%s\n' "$A_FUERTE" "$_b" "$_sub" "$A_FIN"
    printf '%s\n' "$_det" | awk -v g="$A_GRIS" -v f="$A_FIN" '{printf "      %s%-22s %s%s\n", g, $1, $2, f}'
  done
fi

ARCHIVOS=0; PESO=0
if [ "$SOLO_BD" -eq 0 ]; then
  paso "Archivos"
  for _c in $CARPETAS; do
    [ -d "$RAIZ/$_c" ] || continue
    _n=$(find "$RAIZ/$_c" -type f ! -name '.gitkeep' ! -path "$NO_BORRAR" 2>/dev/null | wc -l | tr -d ' ')
    [ "$_n" -eq 0 ] && { tenue "$_c/ · vacío"; continue; }
    _k=$(find "$RAIZ/$_c" -type f ! -name '.gitkeep' ! -path "$NO_BORRAR" -exec cat {} + 2>/dev/null | wc -c | tr -d ' ')
    ARCHIVOS=$((ARCHIVOS + _n)); PESO=$((PESO + _k))
    printf '  %s%-24s %3s archivos · %s KB%s\n' "$A_FUERTE" "$_c/" "$_n" "$((_k / 1024))" "$A_FIN"
  done
fi

if [ "$FILAS" -eq 0 ] && [ "$ARCHIVOS" -eq 0 ]; then
  paso "Ya estaba a cero · nada que borrar"
  printf '\n'
  exit 0
fi

# ═══ CONFIRMAR ═══════════════════════════════════════════════════════════════
# Esto no se deshace: no hay copia, y el outbox de C3 es el único registro de
# lo que se ofreció en la corrida anterior.
if [ "$SI" -eq 0 ]; then
  printf '\n%s  Se borran %s filas y %s archivos. No se puede deshacer.%s\n' \
    "$A_AMBAR" "$FILAS" "$ARCHIVOS" "$A_FIN"
  printf '  %s¿Seguir? [s/N] %s' "$A_FUERTE" "$A_FIN"
  if [ -t 0 ]; then read -r _r < /dev/tty; else _r=""; fi
  case "$_r" in
    s|S|si|SI|Si|y|Y|yes) ;;
    *) printf '\n  cancelado · no se tocó nada\n\n'; exit 1 ;;
  esac
fi

# ═══ PARAR ═══════════════════════════════════════════════════════════════════
# Vaciar las tablas con C3 y C4 corriendo no deja la base vacía: el relay sigue
# publicando y C4 sigue insertando, así que el TRUNCATE se pisa con escrituras
# en vuelo y quedan filas de una corrida que ya no existe.
if [ "$SOLO_LOGS" -eq 0 ] && [ -x "$RAIZ/start.sh" ]; then
  _arriba=0
  for _p in "$PUERTO_C3_1" "$PUERTO_C3_2" "$PUERTO_ORQ" "$PUERTO_C4"; do
    nc -z "$PG_HOST" "$_p" >/dev/null 2>&1 && _arriba=1
  done
  if [ "$_arriba" -eq 1 ]; then
    aviso "hay servicios arriba · se paran antes de vaciar"
    sh "$RAIZ/start.sh" --parar >/dev/null 2>&1
    ok "servicios detenidos"
  fi
fi

# ═══ VACIAR LAS BASES ════════════════════════════════════════════════════════
if [ "$SOLO_LOGS" -eq 0 ]; then
  paso "Vaciando las bases"
  for _b in $BASES; do
    psql_ -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$_b'" 2>/dev/null | grep -q 1 || continue
    _t=$(psql_ -d "$_b" -tAc "$TABLAS_SQL" 2>/dev/null | tr -d '\r')
    [ -z "$_t" ] && { tenue "$_b · sin tablas"; continue; }
    # RESTART IDENTITY para que las secuencias vuelvan a 1 —si no, la corrida
    # nueva arranca con ids que sugieren un histórico que ya no existe—, y
    # CASCADE porque las tablas de C4 se referencian entre sí.
    if psql_ -d "$_b" -q -c "TRUNCATE $_t RESTART IDENTITY CASCADE" >/dev/null 2>&1; then
      ok "$_b · vaciada"
    else
      morir "no se pudo vaciar $_b"
    fi
  done
fi

# ═══ BORRAR ARCHIVOS ═════════════════════════════════════════════════════════
if [ "$SOLO_BD" -eq 0 ]; then
  paso "Borrando archivos"
  for _c in $CARPETAS; do
    [ -d "$RAIZ/$_c" ] || continue
    find "$RAIZ/$_c" -mindepth 1 ! -name '.gitkeep' ! -path "$NO_BORRAR" -delete 2>/dev/null
    ok "$_c/ · vacío"
  done
  mkdir -p "$LOGS/pids"
fi

# ═══ VERIFICAR ═══════════════════════════════════════════════════════════════
# Un borrado que no se comprueba es una suposición, y aquí la suposición se
# paga con una corrida entera medida sobre datos de la anterior.
paso "Verificación"
_mal=0
if [ "$SOLO_LOGS" -eq 0 ]; then
  for _b in $BASES; do
    psql_ -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$_b'" 2>/dev/null | grep -q 1 || continue
    _n=$(psql_ -d "$_b" -tAc "$CONTEO_SQL" 2>/dev/null | awk '{s+=$2} END {print s+0}')
    if [ "${_n:-0}" -eq 0 ]; then ok "$_b · 0 filas"
    else malo "$_b · quedan $_n filas"; _mal=1; fi
  done
fi
if [ "$SOLO_BD" -eq 0 ]; then
  _q=0
  for _c in $CARPETAS; do
    [ -d "$RAIZ/$_c" ] || continue
    _q=$((_q + $(find "$RAIZ/$_c" -type f ! -name '.gitkeep' ! -path "$NO_BORRAR" 2>/dev/null | wc -l | tr -d ' ')))
  done
  if [ "$_q" -eq 0 ]; then ok "0 archivos en las carpetas de logs y salida"
  else malo "quedan $_q archivos"; _mal=1; fi
fi

paso "A cero"
tenue "el esquema de las bases sigue en pie · lo revalida cada servicio al arrancar"
tenue "intactos · dist/ · node_modules/ · los .env"
printf '\n'
aviso "la cola SQS NO se tocó. Si quedaron mensajes de la corrida anterior,"
tenue "C4 los insertará al arrancar y la próxima medición saldrá inflada."
tenue "La de LOCAL es la que sale de c4/.env — no la del despliegue:"
printf '%s    Q=$(grep -m1 SQS_QUEUE_URL c4/.env | cut -d= -f2-)\n' "$A_GRIS"
printf '    aws sqs get-queue-attributes --queue-url "$Q" \\\n'
printf '      --attribute-names ApproximateNumberOfMessages\n'
printf '    aws sqs purge-queue --queue-url "$Q"%s\n\n' "$A_FIN"
tenue "levantar todo de nuevo:  sh start"
printf '\n'

exit "$_mal"
