#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# sql — una consulta contra una base del despliegue, por el tunel del bastion.
#
#   sh sql db 01 "select count(*) from c3.outbox"
#   sh sql c4    "select count(*) from c4.inbox"
#   sh sql c4    --resumen              los contadores que responden P4
#   sh sql db 01 --resumen
#
#   sh sql db --todos --resumen         LAS N BASES DE C3, una por fila + TOTAL
#   sh sql db --todos "select count(*) from c3.outbox"
#
#   --puerto N   usar un tunel ya abierto en ese puerto local
#
# ── Por que existe ──────────────────────────────────────────────────────────
#
# Para no depender de que haya `psql` instalado. El cliente de Postgres de
# Node ya esta en el repo (c4/node_modules/pg), y la contrasena ya esta en
# Secrets Manager: no hay razon para pedirle al que llega que instale nada ni
# que copie una clave a mano.
#
# ── Que hace por ti ─────────────────────────────────────────────────────────
#
#   1. abre el tunel si no estaba abierto -y lo deja abierto para la siguiente-
#   2. lee la contrasena de Secrets Manager
#   3. conecta con sslmode=no-verify, que es lo que RDS exige y Node no verifica
#
# El (3) es el que hace perder una tarde: RDS PostgreSQL 15+ trae
# `rds.force_ssl=1` y rechaza la conexion en claro, pero su CA no esta en el
# trust store de Node — con `require` falla con "self-signed certificate in
# certificate chain", que suena a problema de credenciales y no lo es.
#
# ── `--todos` · por que existe y por que va DE UNA EN UNA ───────────────────
#
# La mitad "salio" de P4 no vive en una base: vive repartida en las N bases de
# los tenants. Con 1 tenant eso no se notaba; con 50, sumar el outbox a mano
# son 50 comandos y una hoja de calculo, y ahi es donde se cuela el error que
# invalida la conciliacion.
#
# Va SECUENCIAL a proposito. Cada base necesita SU tunel -son N hosts
# distintos-, y 50 sesiones de Session Manager simultaneas contra un t4g.nano
# es pedirle al bastion justo lo que no es. Abre, consulta, cierra: tarda unos
# minutos y no deja 50 puertos colgando. Los tuneles que YA estaban abiertos
# se reutilizan y NO se cierran — no son suyos.
#
# Para una GUI (DBeaver, TablePlus, DataGrip): abre el tunel con
# `sh tunel db 01 --fondo` y apunta a localhost:15401, base `poc`, usuario
# `app`, SSL en "no verificar". La contrasena sale de `sh acceso --clave`.
# ─────────────────────────────────────────────────────────────────────────────
set -u

RAIZ=$(cd "$(dirname "$0")" && pwd)
ESCENARIO=${ESCENARIO:-oneClient}
DIR="$RAIZ/terraform/$ESCENARIO"
PG="$RAIZ/c4/node_modules/pg"
TF=${TF_BIN:-tofu}

if [ -t 1 ]; then
  A_ROJO=$(printf '\033[31m'); A_VERDE=$(printf '\033[32m')
  A_AMBAR=$(printf '\033[33m')
  A_GRIS=$(printf '\033[90m'); A_FUERTE=$(printf '\033[1m'); A_FIN=$(printf '\033[0m')
else
  A_ROJO=''; A_VERDE=''; A_AMBAR=''; A_GRIS=''; A_FUERTE=''; A_FIN=''
fi
ok()    { printf '  %s✔%s %s\n' "$A_VERDE" "$A_FIN" "$*"; }
aviso() { printf '  %s!%s %s\n' "$A_AMBAR" "$A_FIN" "$*"; }
tenue() { printf '  %s%s%s\n' "$A_GRIS" "$*" "$A_FIN"; }
morir() { printf '\n%s✘ %s%s\n\n' "$A_ROJO" "$*" "$A_FIN"; exit 1; }

command -v aws  >/dev/null 2>&1 || morir "falta la CLI de AWS"
command -v node >/dev/null 2>&1 || morir "falta node"
command -v jq   >/dev/null 2>&1 || morir "falta jq"
[ -d "$PG" ] || morir "falta el cliente de Postgres · (cd c4 && npm ci)"
[ -d "$DIR" ] || morir "no existe terraform/$ESCENARIO"

tf() { (cd "$DIR" && "$TF" "$@"); }
REGION=$(aws configure get region 2>/dev/null || echo us-west-2)

# El nombre del secreto lo decide `name_prefix`, no una constante. Con el
# prefijo escrito a mano, cambiar de escenario -o de prefijo- daba
# "no pude leer la contrasena", que suena a permisos y no lo es.
PREFIJO=$(grep -E '^[[:space:]]*name_prefix' "$DIR/terraform.tfvars" 2>/dev/null \
  | sed 's/.*= *"\(.*\)".*/\1/' | head -1)
[ -n "$PREFIJO" ] || morir "no pude leer name_prefix de terraform/$ESCENARIO/terraform.tfvars"

QUE=${1:-}; [ $# -gt 0 ] && shift
NN=""; PUERTO=""; CONSULTA=""; RESUMEN=0; TODOS=0

case "$QUE" in
  db)   NN=${1:-}; [ -n "$NN" ] && shift
        case "$NN" in
          --todos|--todas) TODOS=1; NN="" ;;
          ''|--*) morir "que tenant? · sh sql db 01 \"select ...\"  (o --todos)" ;;
        esac ;;
  c4)   ;;
  ''|-h|--help) sed -n '3,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *)    morir "no se que base es '$QUE' · usa 'db NN', 'db --todos' o 'c4'" ;;
esac

while [ $# -gt 0 ]; do
  case "$1" in
    --puerto)  PUERTO=${2:-}; shift 2 ;;
    --resumen) RESUMEN=1; shift ;;
    --todos|--todas) TODOS=1; shift ;;
    *)         CONSULTA=$1; shift ;;
  esac
done

[ "$TODOS" = "1" ] && [ "$QUE" = "c4" ] && morir "--todos es para las bases de C3 · C4 tiene una sola"
[ "$TODOS" = "1" ] && [ -n "$PUERTO" ] && morir "--todos abre un tunel por base · --puerto no aplica"

sin_ceros() { echo "$1" | sed 's/^0*//'; }

# ── Las consultas de --resumen ──────────────────────────────────────────────
resumen_c3="select count(*)::int documentos,
                   count(distinct payload_hash)::int hashes_unicos,
                   count(distinct rpf_id)::int expedientes,
                   count(*) filter (where status = 'SENT')::int enviados,
                   count(*) filter (where status = 'PENDING')::int pendientes,
                   count(*) filter (where status = 'FAILED')::int fallidos,
                   max(attempts)::int intentos_max,
                   max(sent_at) ultimo_envio
            from c3.outbox"

resumen_c4="select count(*)::int documentos,
                   count(distinct rpf_id)::int expedientes,
                   sum(duplicados)::int duplicados,
                   max(recepciones)::int recepciones_max,
                   min(e10_persistido) primero,
                   max(e10_persistido) ultimo
            from c4.inbox"

if [ "$QUE" = "db" ]; then
  ESQUEMA=c3
  [ "$TODOS" = "1" ] || { [ -n "$PUERTO" ] || PUERTO=$((15400 + $(sin_ceros "$NN"))); DESTINO="db $NN"; }
else
  ESQUEMA=c4
  [ -n "$PUERTO" ] || PUERTO=15499
  DESTINO="c4db"
fi

if [ "$RESUMEN" = "1" ] && [ -z "$CONSULTA" ]; then
  if [ "$ESQUEMA" = "c3" ]; then CONSULTA=$resumen_c3; else CONSULTA=$resumen_c4; fi
fi
[ -n "$CONSULTA" ] || morir "falta la consulta · sh sql $QUE${NN:+ $NN} \"select ...\"  (o --resumen)"

# ── La contrasena, una sola vez ─────────────────────────────────────────────
# Con --todos se lee UNA vez y se reutiliza para las N bases: es la misma
# clave a proposito (ver ACCESO.md), y 50 llamadas a Secrets Manager para leer
# 50 veces lo mismo solo anaden latencia y ruido en CloudTrail.
CLAVE=$(aws secretsmanager get-secret-value \
  --secret-id "$PREFIJO-db-password" --region "$REGION" \
  --query SecretString --output text 2>/dev/null)
[ -n "$CLAVE" ] || morir "no pude leer $PREFIJO-db-password de Secrets Manager"

# ── El cliente ──────────────────────────────────────────────────────────────
# Un solo sitio donde se conecta. `FORMATO=json` devuelve la primera fila como
# JSON en una linea -es lo que --todos agrega-; sin el, imprime para leer.
consultar() { # puerto  consulta  [json]
  PGPUERTO="$1" PGCLAVE="$CLAVE" PGSQL="$2" PGMOD="$PG" PGFMT="${3:-tabla}" node -e '
const { Pool } = require(process.env.PGMOD);
const pool = new Pool({
  host: "127.0.0.1",
  port: Number(process.env.PGPUERTO),
  user: "app",
  password: process.env.PGCLAVE,
  database: "poc",
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000,
});
const json = process.env.PGFMT === "json";
pool.query(process.env.PGSQL)
  .then((r) => {
    if (json) { console.log(JSON.stringify(r.rows[0] ?? {})); return; }
    if (!r.rows.length) { console.log("  (sin filas)"); return; }
    // Una columna por linea cuando hay una sola fila: un resumen de 7 columnas
    // en horizontal no se lee en una terminal.
    if (r.rows.length === 1) {
      const f = r.rows[0];
      const ancho = Math.max(...Object.keys(f).map((k) => k.length));
      for (const [k, v] of Object.entries(f)) {
        console.log("  " + k.padEnd(ancho) + "  " + (v === null ? "—" : v));
      }
    } else {
      console.table(r.rows);
    }
  })
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch((e) => {
    if (json) { console.log(JSON.stringify({ _error: e.message })); process.exit(0); }
    console.log("  ERROR: " + e.message); process.exit(1);
  });
'
}

# ── El tunel ────────────────────────────────────────────────────────────────
# Si el puerto ya responde, se reutiliza. Abrir un segundo tunel al mismo
# puerto fallaria con "address already in use" y el error no diria que YA
# tenias uno bueno.
#
# Devuelve 0 si ya estaba abierto -no es tuyo, no lo cierres- y 1 si lo abrio
# este proceso.
# ⚠ EL BASTION SE DESCONECTA, Y NO ES UN FALLO DEL TUNEL.
#
#   Es un t4g.nano -2 vCPU de rafaga, 512 MB-. Abrir y cerrar sesiones de
#   Session Manager en rapida sucesion tumba a su agente, que pierde la
#   conexion con SSM y vuelve al cabo de medio minuto.
#
#   El error que sale entonces es `TargetNotConnected`, y NO dice que el
#   problema sea el agente: parece que la base no responde. Medido en un
#   `--todos` de 39: fallaron las 31 primeras y funcionaron las 8 ultimas,
#   justo cuando el agente ya habia vuelto.
#
#   Por eso se reintenta en vez de darla por muerta. Tres intentos con espera
#   creciente cubren de sobra la reconexion.
abrir_tunel() { # destino  puerto   →  MIO=0|1
  MIO=0
  nc -z 127.0.0.1 "$2" >/dev/null 2>&1 && return 0
  _i=1
  while [ "$_i" -le 3 ]; do
    sh "$RAIZ/tunel.sh" $1 --fondo --puerto "$2" >/dev/null 2>&1
    if nc -z 127.0.0.1 "$2" >/dev/null 2>&1; then MIO=1; return 0; fi
    # Si fue el agente, esperar a que vuelva. Cualquier otro error no mejora
    # esperando, pero tres intentos tampoco cuestan nada a esta escala.
    cerrar_tunel "$2"
    _i=$((_i + 1))
    [ "$_i" -le 3 ] && sleep $((_i * 10))
  done
  return 1
}

# El agente del bastion, antes de empezar. Con 39 bases, descubrir a mitad que
# el bastion no responde cuesta cinco minutos de barrido inutil.
esperar_bastion() {
  _b=$(cd "$DIR" && "$TF" output -json bastiones 2>/dev/null | jq -r '.c3 // empty')
  [ -n "$_b" ] || return 0
  _i=0
  while [ "$_i" -lt 12 ]; do
    _p=$(aws ssm describe-instance-information --region "$REGION" \
      --filters "Key=InstanceIds,Values=$_b" \
      --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null)
    [ "$_p" = "Online" ] && return 0
    [ "$_i" = "0" ] && tenue "el agente del bastion esta $_p — esperando a que vuelva"
    _i=$((_i + 1)); sleep 10
  done
  aviso "el bastion sigue sin conectar tras 2 min · los tuneles van a fallar"
  return 1
}

# ⚠ MATAR EL PROCESO LOCAL NO CIERRA LA SESION EN AWS.
#
#   `aws ssm start-session` abre una sesion del lado de AWS que sigue viva
#   aunque mates al plugin: se queda hasta caducar por inactividad, y eso son
#   minutos. Con 1 tenant no se nota. Con 39, un solo `--todos` abre y cierra
#   39 sesiones, y al segundo o tercer barrido se acumulan por encima del tope
#   de sesiones concurrentes de la cuenta.
#
#   El sintoma NO dice "limite de sesiones": las aperturas nuevas simplemente
#   no llegan a escuchar, `--todos` reporta "sin tunel" en casi todas las bases
#   y parece que las RDS no responden. Medido: 50 sesiones vivas y 38 de 39
#   bases dando error.
#
#   Por eso se lee el SessionId del log y se termina explicitamente.
cerrar_tunel() { # puerto
  for _p in $(lsof -ti "TCP:$1" -sTCP:LISTEN 2>/dev/null); do kill "$_p" 2>/dev/null; done
  for _l in "$RAIZ/.tuneles"/*-"$1".log; do
    [ -f "$_l" ] || continue
    _sid=$(grep -oE 'SessionId: [A-Za-z0-9_-]+' "$_l" | head -1 | cut -d' ' -f2)
    [ -n "$_sid" ] && aws ssm terminate-session --session-id "$_sid" --region "$REGION" >/dev/null 2>&1
    rm -f "$_l"
  done
  rm -f "$RAIZ/.tuneles"/*-"$1".pid 2>/dev/null
}

# ═══ UNA SOLA BASE ══════════════════════════════════════════════════════════
if [ "$TODOS" = "0" ]; then
  if ! nc -z 127.0.0.1 "$PUERTO" >/dev/null 2>&1; then
    tenue "abriendo el tunel a $DESTINO en localhost:$PUERTO"
    abrir_tunel "$DESTINO" "$PUERTO" \
      || morir "no pude abrir el tunel · pruebalo suelto: sh tunel $DESTINO"
  fi

  printf '\n%s▸ %s%s  %s\n\n' "$A_FUERTE" "$ESQUEMA" "$A_FIN" "localhost:$PUERTO"
  consultar "$PUERTO" "$CONSULTA"
  _r=$?
  printf '\n'
  [ "$_r" = "0" ] && tenue "el tunel sigue abierto · cerrar: sh tunel --cerrar"
  printf '\n'
  exit "$_r"
fi

# ═══ TODAS LAS BASES DE C3 ══════════════════════════════════════════════════
TENANTS=$(tf output -json db_endpoints 2>/dev/null | jq -r '.tenants // {} | keys[]' 2>/dev/null)
[ -n "$TENANTS" ] || morir "no hay ninguna RDS de tenant · ¿esta encendido el despliegue?"
N=$(printf '%s\n' "$TENANTS" | wc -l | tr -d ' ')

esperar_bastion

printf '\n%s▸ c3 · %s bases%s\n' "$A_FUERTE" "$N" "$A_FIN"
tenue "una por una: cada base es un host distinto y necesita su propio tunel"
tenue "los tuneles que ya estaban abiertos se reutilizan y no se cierran"
printf '\n'

FILAS=$(mktemp) || morir "no pude crear un temporal"
trap 'rm -f "$FILAS"' EXIT

_i=0
for t in $TENANTS; do
  _i=$((_i + 1))
  _puerto=$((15400 + $(sin_ceros "$t")))
  printf '  %s[%s/%s]%s tenant-%s  ' "$A_GRIS" "$_i" "$N" "$A_FIN" "$t"

  if ! abrir_tunel "db $t" "$_puerto"; then
    printf '%s✘ sin tunel%s\n' "$A_ROJO" "$A_FIN"
    printf '%s\t{"_error":"no pude abrir el tunel"}\n' "$t" >> "$FILAS"
    continue
  fi
  _mio=$MIO

  _json=$(consultar "$_puerto" "$CONSULTA" json 2>/dev/null)
  # Un respiro antes de cerrar y abrir la siguiente: el cuello no es la
  # consulta, es la rotacion de sesiones contra un t4g.nano.
  [ "$_mio" = "1" ] && { cerrar_tunel "$_puerto"; sleep 1; }

  case "$_json" in
    *'"_error"'*) printf '%s✘%s %s\n' "$A_ROJO" "$A_FIN" "$(printf '%s' "$_json" | jq -r '._error' | head -c 60)" ;;
    ''|'{}')      printf '%s!%s sin filas\n' "$A_AMBAR" "$A_FIN"; _json='{}' ;;
    *)            printf '%s✔%s\n' "$A_VERDE" "$A_FIN" ;;
  esac
  printf '%s\t%s\n' "$t" "$_json" >> "$FILAS"
done

# ── La tabla y el TOTAL ─────────────────────────────────────────────────────
#
# El total suma SOLO las columnas numericas, y no todas significan lo mismo
# sumadas: `documentos` y `enviados` si -son cuentas disjuntas por base-, pero
# `intentos_max` es un maximo y sumarlo no querria decir nada. Por eso las
# columnas que empiezan por `max`/`ultimo`/`primero` se agregan como maximo y
# no como suma, y las de fecha se dejan como la mas reciente.
printf '\n'
FILAS="$FILAS" node -e '
const fs = require("fs");
const filas = fs.readFileSync(process.env.FILAS, "utf8").trim().split("\n")
  .filter(Boolean)
  .map((l) => { const [t, j] = l.split("\t"); return { tenant: t, d: JSON.parse(j) }; });

const conDatos = filas.filter((f) => !f.d._error && Object.keys(f.d).length);
if (!conDatos.length) { console.log("  ninguna base respondio"); process.exit(1); }

const cols = Object.keys(conDatos[0].d);
// ⚠ TAMBIEN POR SUFIJO, no solo por prefijo.
//
//   `intentos_max` es un MAXIMO por base y sumarlo no significa nada: 39 bases
//   con 1 intento cada una daban "intentos_max 39" en la fila TOTAL, que se lee
//   como "hubo 39 reintentos" — exactamente lo contrario de lo que paso.
//   Un total que miente es peor que no tenerlo.
const esMax = (c) => /^(max|min|ultimo|primero)|_(max|min)$/.test(c);
const esMin = (c) => /^(min|primero)|_min$/.test(c);

const tabla = filas.map((f) => {
  const fila = { tenant: "tenant-" + f.tenant };
  if (f.d._error) { fila[cols[0]] = "ERROR"; return fila; }
  for (const c of cols) fila[c] = f.d[c] ?? null;
  return fila;
});

const total = { tenant: "TOTAL (" + conDatos.length + ")" };
for (const c of cols) {
  const vals = conDatos.map((f) => f.d[c]).filter((v) => v !== null && v !== undefined);
  if (!vals.length) { total[c] = null; continue; }
  if (typeof vals[0] === "number") {
    total[c] = esMin(c) ? Math.min(...vals)
             : esMax(c) ? Math.max(...vals)
             : vals.reduce((a, b) => a + b, 0);
  } else {
    // Fechas y texto: la mas reciente / la ultima en orden. Sumar no aplica.
    total[c] = vals.map(String).sort().at(esMin(c) ? 0 : -1);
  }
}
console.table([...tabla, total]);

const fallidas = filas.filter((f) => f.d._error);
if (fallidas.length) {
  console.log("\n  " + fallidas.length + " base(s) sin responder: " +
    fallidas.map((f) => f.tenant).join(", "));
}
'
_r=$?
printf '\n'
tenue "la otra mitad de P4:  sh sql c4 --resumen"
printf '\n'
exit "$_r"
