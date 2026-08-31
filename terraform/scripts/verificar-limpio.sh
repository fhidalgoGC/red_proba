#!/usr/bin/env bash
# T-10 — Verifica que la PoC no dejó nada vivo facturando.
#
# ⚠ Filtra por Project=rpf-proof-ledger a propósito.
#   La cuenta 276076558677 NO está vacía: ya tiene un cluster ECS
#   'cluster-test' (CloudFormation/Copilot) y dos VPC ajenas.
#   Sin el filtro, este script las reportaría como basura nuestra
#   y alguien terminaría borrando infraestructura de otro.
#
# Correr DOS veces: justo tras el destroy, y al día siguiente con costos.sh.
set -uo pipefail

PROJECT_TAG="${PROJECT_TAG:-rpf-proof-ledger}"
REGION="${AWS_REGION:-us-west-2}"
SUCIO=0

titulo() { echo; echo "── $1"; }

# La CLI de AWS imprime el literal "None" -no vacio- cuando el --query
# no matchea nada. Sin esto, "None" se lee como recurso vivo.
limpiar() { tr '\t' '\n' | sed 's/^None$//' | grep -v '^[[:space:]]*$' || true; }

reportar() {   # reportar <etiqueta> <lineas>
  if [ -n "${2//[[:space:]]/}" ]; then
    echo "  ⚠ QUEDA VIVO:"; echo "$2" | sed 's|^|    |'; SUCIO=1
  else
    echo "  ✓ limpio"
  fi
}

echo "════════ cuenta $(aws sts get-caller-identity --query Account --output text) · región $REGION"
echo "════════ filtro: Project=$PROJECT_TAG"

titulo "Recursos con nuestro tag (Resource Groups Tagging API)"
TAGGED=$(aws resourcegroupstaggingapi get-resources --region "$REGION" \
  --tag-filters "Key=Project,Values=$PROJECT_TAG" \
  --query 'ResourceTagMappingList[].ResourceARN' --output text 2>/dev/null | limpiar)
reportar "tagged" "$TAGGED"

titulo "ECS services de la PoC con desiredCount != 0"
SVC=""
for C in $(aws ecs list-clusters --region "$REGION" --query 'clusterArns[]' --output text 2>/dev/null); do
  case "$C" in *rpf*|*poc*) ;; *) continue ;; esac   # ignora clusters ajenos
  for S in $(aws ecs list-services --cluster "$C" --region "$REGION" \
             --query 'serviceArns[]' --output text 2>/dev/null); do
    SVC+=$(aws ecs describe-services --cluster "$C" --services "$S" --region "$REGION" \
      --query "services[?desiredCount!=\`0\`].[serviceName,desiredCount]" --output text 2>/dev/null | limpiar)
  done
done
reportar "services" "$SVC"

titulo "Tareas en RUNNING en clusters de la PoC"
TASKS=""
for C in $(aws ecs list-clusters --region "$REGION" --query 'clusterArns[]' --output text 2>/dev/null); do
  case "$C" in *rpf*|*poc*) ;; *) continue ;; esac
  TASKS+=$(aws ecs list-tasks --cluster "$C" --desired-status RUNNING --region "$REGION" \
    --query 'taskArns[]' --output text 2>/dev/null | limpiar)
done
reportar "tasks" "$TASKS"

titulo "VPC endpoints de la PoC (facturan por hora, ~\$0,01/h por ENI)"
VPCE=$(aws ec2 describe-vpc-endpoints --region "$REGION" \
  --filters "Name=tag:Project,Values=$PROJECT_TAG" \
  --query 'VpcEndpoints[].[VpcEndpointId,ServiceName]' --output text 2>/dev/null | limpiar)
reportar "endpoints" "$VPCE"

titulo "ENIs sin liberar (las de los endpoints tardan tras el destroy)"
ENIS=$(aws ec2 describe-network-interfaces --region "$REGION" \
  --filters "Name=tag:Project,Values=$PROJECT_TAG" \
  --query 'NetworkInterfaces[].[NetworkInterfaceId,Status]' --output text 2>/dev/null | limpiar)
reportar "enis" "$ENIS"

titulo "NAT Gateways (NO debería haber NINGUNO — ver 06-infraestructura)"
NAT=$(aws ec2 describe-nat-gateways --region "$REGION" \
  --query 'NatGateways[?State!=`deleted`].[NatGatewayId,State]' --output text 2>/dev/null | limpiar)
reportar "nat" "$NAT"

titulo "Colas SQS de la PoC (no se borran con mensajes en vuelo)"
SQS=$(aws sqs list-queues --region "$REGION" --queue-name-prefix rpf \
  --query 'QueueUrls[]' --output text 2>/dev/null | limpiar)
reportar "sqs" "$SQS"

titulo "Llaves KMS en PendingDeletion (siguen contando para la cuota)"
KMS=""
for K in $(aws kms list-keys --region "$REGION" --query 'Keys[].KeyId' --output text 2>/dev/null); do
  KMS+=$(aws kms describe-key --key-id "$K" --region "$REGION" \
    --query "KeyMetadata[?KeyState=='PendingDeletion'].[KeyId,DeletionDate]" --output text 2>/dev/null | limpiar)
done
if [ -n "${KMS//[[:space:]]/}" ]; then
  echo "  ℹ en periodo de espera (esperado tras destroy, no es un error):"
  echo "$KMS" | sed 's|^|    |'
else
  echo "  ✓ ninguna"
fi

echo
if [ "$SUCIO" -eq 0 ]; then
  echo "════════ ✓ LIMPIO — la PoC no deja nada facturando."
else
  echo "════════ ⚠ QUEDA ALGO VIVO. Revisá lo marcado arriba."
fi
echo "Mañana: scripts/costos.sh resumen  (Cost Explorer atrasa ~24 h)"
exit "$SUCIO"
