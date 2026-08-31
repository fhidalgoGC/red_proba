#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# sql — una consulta contra una base del despliegue, por el tunel del bastion.
#
#   sh sql db 01 "select count(*) from c3.outbox"
#   sh sql c4    "select count(*) from c4.inbox"
#   sh sql c4    --resumen              los contadores que responden P4
#   sh sql db 01 --resumen
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
# Para una GUI (DBeaver, TablePlus, DataGrip): abre el tunel con
# `sh tunel db 01 --fondo` y apunta a localhost:15401, base `poc`, usuario
# `app`, SSL en "no verificar". La contrasena sale de `cat ACCESO.md`.
# ─────────────────────────────────────────────────────────────────────────────
set -u

RAIZ=$(cd "$(dirname "$0")" && pwd)
ESCENARIO=${ESCENARIO:-oneClient}
DIR="$RAIZ/terraform/$ESCENARIO"
PG="$RAIZ/c4/node_modules/pg"

if [ -t 1 ]; then
  A_ROJO=$(printf '\033[31m'); A_VERDE=$(printf '\033[32m')
  A_GRIS=$(printf '\033[90m'); A_FUERTE=$(printf '\033[1m'); A_FIN=$(printf '\033[0m')
else
  A_ROJO=''; A_VERDE=''; A_GRIS=''; A_FUERTE=''; A_FIN=''
fi
ok()    { printf '  %s✔%s %s\n' "$A_VERDE" "$A_FIN" "$*"; }
tenue() { printf '  %s%s%s\n' "$A_GRIS" "$*" "$A_FIN"; }
morir() { printf '\n%s✘ %s%s\n\n' "$A_ROJO" "$*" "$A_FIN"; exit 1; }

command -v aws  >/dev/null 2>&1 || morir "falta la CLI de AWS"
command -v node >/dev/null 2>&1 || morir "falta node"
[ -d "$PG" ] || morir "falta el cliente de Postgres · (cd c4 && npm ci)"

QUE=${1:-}; [ $# -gt 0 ] && shift
NN=""; PUERTO=""; CONSULTA=""; RESUMEN=0

case "$QUE" in
  db)   NN=${1:-}; [ -n "$NN" ] && shift
        [ -n "$NN" ] || morir "que tenant? · sh sql db 01 \"select ...\"" ;;
  c4)   ;;
  ''|-h|--help) sed -n '3,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *)    morir "no se que base es '$QUE' · usa 'db NN' o 'c4'" ;;
esac

while [ $# -gt 0 ]; do
  case "$1" in
    --puerto)  PUERTO=${2:-}; shift 2 ;;
    --resumen) RESUMEN=1; shift ;;
    *)         CONSULTA=$1; shift ;;
  esac
done

sin_ceros() { echo "$1" | sed 's/^0*//'; }

if [ "$QUE" = "db" ]; then
  ESQUEMA=c3
  [ -n "$PUERTO" ] || PUERTO=$((15400 + $(sin_ceros "$NN")))
  DESTINO="db $NN"
else
  ESQUEMA=c4
  [ -n "$PUERTO" ] || PUERTO=15499
  DESTINO="c4db"
fi

if [ "$RESUMEN" = "1" ] && [ -z "$CONSULTA" ]; then
  if [ "$ESQUEMA" = "c3" ]; then
    # Lo que C3 tiene que contar: cuanto entro, cuanto salio y cuanto quedo.
    CONSULTA="select count(*)::int documentos,
                     count(distinct payload_hash)::int hashes_unicos,
                     count(distinct rpf_id)::int expedientes,
                     count(*) filter (where status = 'SENT')::int enviados,
                     count(*) filter (where status = 'PENDING')::int pendientes,
                     count(*) filter (where status = 'FAILED')::int fallidos,
                     max(attempts)::int intentos_max,
                     max(sent_at) ultimo_envio
              from c3.outbox"
  else
    # La mitad 'llegado' de P4.
    CONSULTA="select count(*)::int documentos,
                     count(distinct rpf_id)::int expedientes,
                     sum(duplicados)::int duplicados,
                     max(recepciones)::int recepciones_max,
                     min(e10_persistido) primero,
                     max(e10_persistido) ultimo
              from c4.inbox"
  fi
fi
[ -n "$CONSULTA" ] || morir "falta la consulta · sh sql $QUE${NN:+ $NN} \"select ...\"  (o --resumen)"

# ── El tunel ────────────────────────────────────────────────────────────────
# Si el puerto ya responde, se reutiliza. Abrir un segundo tunel al mismo
# puerto fallaria con "address already in use" y el error no diria que YA
# tenias uno bueno.
if ! nc -z 127.0.0.1 "$PUERTO" >/dev/null 2>&1; then
  tenue "abriendo el tunel a $DESTINO en localhost:$PUERTO"
  sh "$RAIZ/tunel.sh" $DESTINO --fondo --puerto "$PUERTO" >/dev/null 2>&1 \
    || morir "no pude abrir el tunel · pruebalo suelto: sh tunel $DESTINO"
  nc -z 127.0.0.1 "$PUERTO" >/dev/null 2>&1 \
    || morir "el tunel no acepta conexiones · mira .tuneles/*.log"
fi

CLAVE=$(aws secretsmanager get-secret-value \
  --secret-id "$(basename "$DIR" >/dev/null; echo rpf-one)-db-password" \
  --region "$(aws configure get region 2>/dev/null || echo us-west-2)" \
  --query SecretString --output text 2>/dev/null)
[ -n "$CLAVE" ] || morir "no pude leer la contrasena de Secrets Manager"

printf '\n%s▸ %s%s  %s\n\n' "$A_FUERTE" "$ESQUEMA" "$A_FIN" "localhost:$PUERTO"

PGPUERTO="$PUERTO" PGCLAVE="$CLAVE" PGSQL="$CONSULTA" PGMOD="$PG" node -e '
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
pool.query(process.env.PGSQL)
  .then((r) => {
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
  .catch((e) => { console.log("  ERROR: " + e.message); process.exit(1); });
'
_r=$?
printf '\n'
[ "$_r" = "0" ] && tenue "el tunel sigue abierto · cerrar: sh tunel --cerrar"
printf '\n'
exit "$_r"
