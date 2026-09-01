#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# VERIFICAR-DESPLIEGUE — ¿está todo lo que tiene que estar, y funciona?
#
#   terraform/scripts/verificar-despliegue.sh [oneClient]
#
# ── Por qué existe ──────────────────────────────────────────────────────────
#
# Con 1 tenant el despliegue se mira a ojo. Con 39 no: son ~500 recursos y la
# forma en que esto falla no es "el apply dio error" —- eso se ve—- sino que
# TERRAFORM DICE QUE TERMINÓ y algo no está corriendo:
#
#   · un service creado con la task en bucle de arranque (imagen, salud, IAM)
#   · una RDS en `creating` cuando el resto ya está `available`
#   · un registro de Cloud Map que no resolvió, y el orquestador da ECONNREFUSED
#     contra ESE tenant y solo ese
#
# Ninguna de las tres aparece en `terraform state list`, que las cuenta como
# creadas. Este script compara lo ESPERADO con lo que la cuenta dice que hay.
#
# ── Y las tres comprobaciones que no son de inventario ──────────────────────
#
# Al final verifica el INVARIANTE, que es lo único que esta PoC tiene que
# demostrar y lo único que un recuento no ve:
#
#   1. C4 no puede firmar          (si pudiera, el Proof Ledger no vale nada)
#   2. no hay ruta entre C3 y C4   (sin peering, TGW ni PrivateLink)
#   3. un tenant no ve la base de otro   (D-02, y falla EN SILENCIO)
#
# Salida: 0 si todo cuadra, 1 si falta algo, 2 si el invariante está roto.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ESC="${1:-oneClient}"
DIR="$RAIZ/$ESC"
TF="${TF_BIN:-tofu}"

if [ -t 1 ]; then
  ROJO=$(printf '\033[31m'); VERDE=$(printf '\033[32m'); AMBAR=$(printf '\033[33m')
  GRIS=$(printf '\033[90m'); FUERTE=$(printf '\033[1m'); FIN=$(printf '\033[0m')
else ROJO=''; VERDE=''; AMBAR=''; GRIS=''; FUERTE=''; FIN=''; fi

FALLOS=0; INVARIANTE=0
titulo() { printf '\n%s▸ %s%s\n' "$FUERTE" "$*" "$FIN"; }
tenue()  { printf '   %s%s%s\n' "$GRIS" "$*" "$FIN"; }

# Compara esperado contra encontrado. Es el corazón del script: un recuento sin
# el número esperado al lado no dice nada.
cuenta() { # etiqueta  esperado  encontrado  [nota]
  local et="$1" esp="$2" hay="$3" nota="${4:-}"
  if [ "$hay" = "$esp" ]; then
    printf '   %s✔%s %-30s %s%s%s\n' "$VERDE" "$FIN" "$et" "$hay" "${nota:+  $GRIS$nota$FIN}" ""
  else
    printf '   %s✘%s %-30s %s%s de %s%s  %s\n' "$ROJO" "$FIN" "$et" "$ROJO" "$hay" "$esp" "$FIN" "$nota"
    FALLOS=$((FALLOS + 1))
  fi
}
bien() { printf '   %s✔%s %s\n' "$VERDE" "$FIN" "$*"; }
mal()  { printf '   %s✘%s %s\n' "$ROJO" "$FIN" "$*"; FALLOS=$((FALLOS + 1)); }
roto() { printf '   %s✘ INVARIANTE ROTO ·%s %s\n' "$ROJO" "$FIN" "$*"; INVARIANTE=1; }
duda() { printf '   %s!%s %s\n' "$AMBAR" "$FIN" "$*"; }

command -v aws >/dev/null || { echo "falta la CLI de AWS"; exit 1; }
command -v jq  >/dev/null || { echo "falta jq"; exit 1; }
[ -d "$DIR" ] || { echo "no existe $DIR"; exit 1; }

REGION=$(aws configure get region 2>/dev/null || echo us-west-2)
PREFIJO=$(grep -E '^[[:space:]]*name_prefix' "$DIR/terraform.tfvars" | sed 's/.*= *"\(.*\)".*/\1/' | head -1)
SALIDA=$(cd "$DIR" && $TF output -json 2>/dev/null)
[ -n "$SALIDA" ] || { echo "no hay estado aplicado en $ESC"; exit 1; }

# ⚠ LO ESPERADO SALE DE `clientes.auto.tfvars`, LO ENCONTRADO DE LA CUENTA.
#
#   Antes las dos mitades salian de `tofu output`, que lee el STATE — es decir,
#   el ultimo apply que llego a commitear. Durante un apply, o si uno murio a
#   mitad, el state dice 1 tenant mientras en la cuenta hay 32: el script
#   comparaba 32 contra 1 y cantaba "sobran 31", que es lo contrario del
#   problema. Y en el caso que de verdad importa —un apply que fallo dejando
#   cosas sin crear— habria dicho que todo cuadra.
#
#   `clientes.auto.tfvars` es la INTENCION: cuantos pediste. Es contra eso que
#   hay que comparar la realidad.
TENANTS=($(grep -oE '"[0-9]+"' "$DIR/clientes.auto.tfvars" 2>/dev/null | tr -d '"'))
if [ ${#TENANTS[@]} -eq 0 ]; then
  TENANTS=($(jq -r '.api_hosts.value | keys[]' <<<"$SALIDA"))
  duda "sin clientes.auto.tfvars — comparando contra el state, que puede ir por detras"
fi
N=${#TENANTS[@]}

# Y se avisa cuando el state va por detras de lo pedido: es la señal de que hay
# un apply corriendo o de que uno se quedo a medias.
EN_STATE=$(jq -r '.api_hosts.value | length' <<<"$SALIDA" 2>/dev/null || echo 0)
if [ "$EN_STATE" != "$N" ]; then
  printf '   %s! el state tiene %s tenant(s) y pediste %s — ¿apply en curso o a medias?%s\n' \
    "$AMBAR" "$EN_STATE" "$N" "$FIN"
fi
AZ=$(grep -oE 'az_count = [0-9]+' "$DIR/clientes.auto.tfvars" 2>/dev/null | grep -oE '[0-9]+$' || echo 2)
PERILLA=$(grep -oE 'desired_count = [0-9]+' "$DIR/estado.auto.tfvars" 2>/dev/null | grep -oE '[0-9]+$' || echo 0)

printf '\n%s┌─────────────────────────────────────────────┐%s\n' "$FUERTE" "$FIN"
printf '%s│  verificar-despliegue · %-19s │%s\n' "$FUERTE" "$ESC" "$FIN"
printf '%s└─────────────────────────────────────────────┘%s\n' "$FUERTE" "$FIN"
tenue "$N tenants · $AZ AZ · desired_count=$PERILLA · $PREFIJO · $REGION"

# ═══ 1 · BASES ══════════════════════════════════════════════════════════════
titulo "Bases de datos · una por tenant + la de C4"
RDS=$(aws rds describe-db-instances --region "$REGION" \
  --query "DBInstances[?starts_with(DBInstanceIdentifier,'$PREFIJO')].[DBInstanceIdentifier,DBInstanceStatus]" \
  --output text 2>/dev/null)
RDS_N=$(grep -c . <<<"$RDS" || echo 0)
RDS_OK=$(awk '$2=="available"' <<<"$RDS" | grep -c . || echo 0)

if [ "$PERILLA" = "0" ]; then
  duda "desired_count=0 · las bases no existen (rds_persistente=false las borra al apagar)"
else
  cuenta "instancias" "$((N + 1))" "$RDS_N"
  cuenta "available" "$((N + 1))" "$RDS_OK"
  # ⚠ Una RDS en `creating` cuenta como creada en el state y NO responde. Es la
  #   que hace que un solo tenant dé timeout mientras los otros 38 van bien.
  awk '$2!="available"{printf "     %s en %s\n",$1,$2}' <<<"$RDS"
  # Los tenants que faltan, por nombre: con 39, "38 de 39" no dice cuál.
  for t in "${TENANTS[@]}"; do
    grep -q "^$PREFIJO-db-$t	" <<<"$RDS" || printf '     %sfalta %s-db-%s%s\n' "$ROJO" "$PREFIJO" "$t" "$FIN"
  done
fi

# ═══ 2 · CÓMPUTO ════════════════════════════════════════════════════════════
titulo "Servicios ECS · el service existe ≠ la tarea corre"
for par in "c3:$N" "c4:1" "orq:1"; do
  cl="${par%%:*}"; esp="${par##*:}"
  SVC=$(aws ecs list-services --cluster "$PREFIJO-$cl" --region "$REGION" \
    --query 'serviceArns' --output text 2>/dev/null | tr '\t' '\n' | grep -c . || echo 0)
  cuenta "services en $PREFIJO-$cl" "$esp" "$SVC"
done

if [ "$PERILLA" != "0" ]; then
  # ⚠ ESTA ES LA COMPROBACIÓN QUE IMPORTA. `runningCount` por debajo de
  #   `desiredCount` es una tarea que no arranca: imagen que no existe, health
  #   check que no pasa, permiso de IAM que falta. El apply salió bien igual.
  for cl in c3 c4 orq; do
    ARNS=$(aws ecs list-services --cluster "$PREFIJO-$cl" --region "$REGION" \
      --query 'serviceArns' --output text 2>/dev/null | tr '\t' '\n' | grep . || true)
    [ -z "$ARNS" ] && continue
    CAIDOS=0; TOTAL=0
    # describe-services acepta 10 por llamada.
    while read -r lote; do
      [ -z "$lote" ] && continue
      D=$(aws ecs describe-services --cluster "$PREFIJO-$cl" --services $lote --region "$REGION" \
        --query 'services[].[serviceName,desiredCount,runningCount]' --output text 2>/dev/null)
      TOTAL=$((TOTAL + $(grep -c . <<<"$D" || echo 0)))
      while IFS=$'\t' read -r nom des run; do
        [ -z "${nom:-}" ] && continue
        if [ "$run" != "$des" ]; then
          printf '     %s%s  corriendo %s de %s%s\n' "$ROJO" "$nom" "$run" "$des" "$FIN"
          CAIDOS=$((CAIDOS + 1))
        fi
      done <<<"$D"
    done < <(xargs -n 10 <<<"$ARNS")
    if [ "$CAIDOS" = "0" ]; then bien "$cl · las $TOTAL tareas corriendo al desired"
    else mal "$cl · $CAIDOS service(s) por debajo del desired"; fi
  done
fi

# ═══ 3 · RED Y DESCUBRIMIENTO ═══════════════════════════════════════════════
titulo "Red · endpoints, Cloud Map y aislamiento por security group"
VPCE=$(aws ec2 describe-vpc-endpoints --region "$REGION" \
  --filters "Name=tag:Name,Values=$PREFIJO-vpce-*" \
  --query 'length(VpcEndpoints[?VpcEndpointType==`Interface`])' --output text 2>/dev/null)
# 7 servicios × 2 VPC. Las ENIs son por AZ, pero el endpoint es uno.
cuenta "interface endpoints" "14" "${VPCE:-0}" "7 por VPC · $((14 * AZ)) ENIs"

NS=$(aws servicediscovery list-namespaces --region "$REGION" \
  --query "Namespaces[?Name=='poc.local'].Id" --output text 2>/dev/null | head -1)
if [ -n "$NS" ] && [ "$NS" != "None" ]; then
  CM=$(aws servicediscovery list-services --region "$REGION" \
    --filters "Name=NAMESPACE_ID,Values=$NS,Condition=EQ" \
    --query 'length(Services)' --output text 2>/dev/null)
  # N × api-NN + orq
  cuenta "registros en poc.local" "$((N + 1))" "${CM:-0}" "api-NN + orq"
else mal "no existe el namespace poc.local"; fi

SG=$(aws ec2 describe-security-groups --region "$REGION" \
  --filters "Name=group-name,Values=$PREFIJO-sg-tenant-*" \
  --query 'length(SecurityGroups)' --output text 2>/dev/null)
cuenta "security groups de tenant" "$N" "${SG:-0}" "uno por tenant · D-02"

LG=$(aws logs describe-log-groups --region "$REGION" \
  --log-group-name-prefix "/ecs/$PREFIJO/" --query 'length(logGroups)' --output text 2>/dev/null)
cuenta "log groups" "$((N + 2))" "${LG:-0}" "N API + C4 + orq"

# ═══ 4 · EL CANAL Y LAS LLAVES ══════════════════════════════════════════════
titulo "El único canal entre los dos dominios"
for q in "$PREFIJO-eventos.fifo" "$PREFIJO-eventos-dlq.fifo"; do
  U=$(aws sqs get-queue-url --queue-name "$q" --region "$REGION" --query QueueUrl --output text 2>/dev/null)
  if [ -n "$U" ] && [ "$U" != "None" ]; then
    A=$(aws sqs get-queue-attributes --queue-url "$U" --region "$REGION" \
      --attribute-names ApproximateNumberOfMessages FifoThroughputLimit \
      --query 'Attributes' --output json 2>/dev/null)
    _n=$(jq -r '.ApproximateNumberOfMessages // "?"' <<<"$A")
    # ⚠ Mensajes en la DLQ no son "informacion de estado": son eventos que
    #   agotaron maxReceiveCount y NO estan en el inbox de C4. Cada uno es un
    #   hueco en P4 que no aparece como error en ningun log.
    if [[ "$q" == *dlq* ]] && [ "$_n" != "0" ] && [ "$_n" != "?" ]; then
      duda "$q · $_n mensaje(s) — eventos que NO llegaron a C4, de corridas anteriores"
      tenue "purgar antes de medir:  aws sqs purge-queue --queue-url $U --region $REGION"
    else
      bien "$q · $_n mensajes en cola"
    fi
  else mal "no existe la cola $q"; fi
done

# ⚠ SIN ESTO EL TECHO ES 300 msg/s PARA TODA LA COLA, no por grupo. No cuesta
#   nada y es lo que se olvida.
U=$(aws sqs get-queue-url --queue-name "$PREFIJO-eventos.fifo" --region "$REGION" --query QueueUrl --output text 2>/dev/null)
if [ -n "$U" ] && [ "$U" != "None" ]; then
  T=$(aws sqs get-queue-attributes --queue-url "$U" --region "$REGION" \
    --attribute-names FifoThroughputLimit --query 'Attributes.FifoThroughputLimit' --output text 2>/dev/null)
  [ "$T" = "perMessageGroupId" ] && bien "alto rendimiento activo (perMessageGroupId)" \
    || mal "alto rendimiento NO activo ($T) · techo 300 msg/s para TODA la cola"
fi

# ═══ 5 · EL INVARIANTE ══════════════════════════════════════════════════════
titulo "El invariante · lo único que un recuento no ve"

# 5.1 · No hay ruta entre C3 y C4.
PEER=$(aws ec2 describe-vpc-peering-connections --region "$REGION" \
  --query 'length(VpcPeeringConnections[?Status.Code==`active`])' --output text 2>/dev/null)
TGW=$(aws ec2 describe-transit-gateway-attachments --region "$REGION" \
  --query 'length(TransitGatewayAttachments[?State==`available`])' --output text 2>/dev/null)
VPCC3=$(jq -r '.vpc_ids.value.c3 // empty' <<<"$SALIDA" 2>/dev/null)
CIDR_C4=$(jq -r '.vpc_cidrs.value.c4 // "10.102.0.0/16"' <<<"$SALIDA" 2>/dev/null)
if [ "${PEER:-0}" != "0" ]; then roto "hay $PEER peering(s) activo(s) — mirar si tocan C3/C4"
else bien "sin VPC peering en la región"; fi
if [ "${TGW:-0}" != "0" ]; then roto "hay $TGW attachment(s) de Transit Gateway"
else bien "sin Transit Gateway"; fi

# La prueba directa: ¿la tabla de rutas de C3 apunta al CIDR de C4?
#
# ⚠ SOLO LA DE C3, Y ESO NO ES UN DETALLE. Con el filtro en `$PREFIJO-rt-*`
#   entraban las DOS tablas, y la de C4 tiene —como toda tabla de rutas— la
#   ruta `local` a su propio CIDR, que es justo 10.102.0.0/16. El script
#   cantaba "INVARIANTE ROTO" sobre la configuracion correcta.
#
#   Un verificador que grita cuando no pasa nada es peor que no tenerlo: a la
#   tercera vez que lo hace, nadie mira la cuarta — y la cuarta es la buena.
RUTAS=$(aws ec2 describe-route-tables --region "$REGION" \
  --filters "Name=tag:Name,Values=$PREFIJO-rt-c3" \
  --query "RouteTables[].Routes[?DestinationCidrBlock=='$CIDR_C4'] | []" --output text 2>/dev/null)
[ -z "$RUTAS" ] && bien "la tabla de rutas de C3 no apunta a $CIDR_C4 (el CIDR de C4)" \
  || roto "la tabla de rutas de C3 tiene una ruta hacia el CIDR de C4: $RUTAS"

# Y la simetrica, que es la que permitiria a C4 iniciar hacia C3.
RUTAS4=$(aws ec2 describe-route-tables --region "$REGION" \
  --filters "Name=tag:Name,Values=$PREFIJO-rt-c4" \
  --query "RouteTables[].Routes[?DestinationCidrBlock=='$(jq -r '.vpc_cidrs.value.c3 // "10.101.0.0/16"' <<<"$SALIDA")'] | []" --output text 2>/dev/null)
[ -z "$RUTAS4" ] && bien "la tabla de rutas de C4 no apunta al CIDR de C3" \
  || roto "la tabla de rutas de C4 tiene una ruta hacia el CIDR de C3: $RUTAS4"

# 5.2 · C4 no puede firmar. Es la asimetría que hace válido el Proof Ledger.
FIRMA=$(jq -r '.kms.value.firma_c3 // empty' <<<"$SALIDA")
ROL_C4=$(aws iam list-roles --query "Roles[?starts_with(RoleName,'$PREFIJO') && contains(RoleName,'c4')].Arn" --output text 2>/dev/null | head -1)
if [ -n "$FIRMA" ] && [ -n "$ROL_C4" ]; then
  # Simula la llamada contra la policy real, sin firmar nada.
  D=$(aws iam simulate-principal-policy --policy-source-arn "$ROL_C4" \
    --action-names kms:Sign --resource-arns "$FIRMA" \
    --query 'EvaluationResults[0].EvalDecision' --output text 2>/dev/null)
  case "$D" in
    allowed) roto "el rol de C4 PUEDE llamar a kms:Sign sobre la llave de firma" ;;
    *)       bien "C4 no puede firmar (kms:Sign → $D)" ;;
  esac
  D=$(aws iam simulate-principal-policy --policy-source-arn "$ROL_C4" \
    --action-names kms:GetPublicKey --resource-arns "$FIRMA" \
    --query 'EvaluationResults[0].EvalDecision' --output text 2>/dev/null)
  [ "$D" = "allowed" ] && bien "C4 sí puede leer la pública (kms:GetPublicKey)" \
    || duda "C4 no puede leer la pública ($D) — no podría verificar firmas"
else duda "no pude resolver la llave de firma o el rol de C4"; fi

# 5.3 · D-02 · un tenant no alcanza la base de otro.
if [ "$N" -ge 2 ]; then
  A=${TENANTS[0]}; B=${TENANTS[1]}
  SGA=$(aws ec2 describe-security-groups --region "$REGION" \
    --filters "Name=group-name,Values=$PREFIJO-sg-tenant-$A" --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null)
  SGB=$(aws ec2 describe-security-groups --region "$REGION" \
    --filters "Name=group-name,Values=$PREFIJO-sg-tenant-$B" --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null)
  # ¿El SG del tenant B admite 5432 desde el SG del tenant A? No debe.
  CRUCE=$(aws ec2 describe-security-groups --region "$REGION" --group-ids "$SGB" \
    --query "SecurityGroups[0].IpPermissions[?FromPort==\`5432\`].UserIdGroupPairs[?GroupId=='$SGA'] | []" \
    --output text 2>/dev/null)
  [ -z "$CRUCE" ] && bien "D-02 · el tenant $A no alcanza el 5432 del $B" \
    || roto "D-02 · el SG del tenant $B admite 5432 desde el $A"
  tenue "la prueba de verdad es desde dentro de la task: 50client/README.md"
else duda "D-02 no se puede probar con $N tenant(s) — hace falta otro contra quién"; fi

# ═══ VEREDICTO ══════════════════════════════════════════════════════════════
printf '\n'
if [ "$INVARIANTE" != "0" ]; then
  printf '%s ✘ EL INVARIANTE ESTÁ ROTO — la PoC no demuestra lo que dice demostrar %s\n\n' "$ROJO$FUERTE" "$FIN"
  exit 2
elif [ "$FALLOS" != "0" ]; then
  printf '%s ✘ faltan %s cosa(s) %s\n' "$ROJO$FUERTE" "$FALLOS" "$FIN"
  tenue "si el apply acaba de terminar, algo puede seguir arrancando: repite en un minuto"
  printf '\n'; exit 1
else
  printf '%s ✔ el despliegue está completo y el invariante se sostiene %s\n\n' "$VERDE$FUERTE" "$FIN"
  exit 0
fi
