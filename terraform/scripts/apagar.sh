#!/usr/bin/env bash
# APAGAR — corta el computo sin destruir. T-07.
#
# Conserva red, llaves y colas. Tambien libera los interface endpoints,
# que son el costo fijo real (~$0,12/h con 1 AZ).
#
# ⚠ Los DATOS no sobreviven salvo rds_persistente=true: RDS no escala a
#   cero, asi que sigue la misma perilla y apagar destruye las instancias.
# Entre corridas se apaga, no se destruye.
#
# ── POR QUE VACIA LOS SERVICIOS ANTES DEL APPLY ─────────────────────────────
#
# `desired_count` y `endpoints_activos` cuelgan de la MISMA variable, asi que en
# un unico apply los dos cambios compiten — y no hay ninguna arista en el grafo
# que obligue a drenar los servicios antes de borrar los endpoints. Ganan los
# endpoints: borrar catorce es mas rapido que drenar cuarenta y dos tareas.
#
# Y sin endpoints, las tareas que siguen vivas no alcanzan ECR, ni KMS, ni su
# base. El health check falla, ECS mata la tarea y arranca otra, que tampoco
# puede hacer pull. Bucle, hasta que el apply llega a los servicios.
#
# Con 1 tenant es una tarea reciclando unos segundos y no se nota. Con 39
# fueron 42 tareas en bucle durante media hora — medido el 2026-09-01: 52 tareas
# vivas en un cluster de 39 servicios, con 10 en PENDING permanente. Factura
# ~$1,54/h de Fargate por no hacer nada.
#
# El arreglo va aqui y no en el grafo de Terraform: acoplar el modulo de red al
# de tenants para forzar el orden anadiria una dependencia entre dominios que
# solo existe para el apagado.

source "$(dirname "${BASH_SOURCE[0]}")/_comun.sh"
escenario "${1:-}"

REGION="$(aws configure get region 2>/dev/null || echo us-west-2)"
PREFIJO=$(grep -E '^[[:space:]]*name_prefix' "$DIR/terraform.tfvars" 2>/dev/null \
  | sed 's/.*= *"\(.*\)".*/\1/' | head -1)

# ── 1/3 · vaciar los servicios y esperar a que dejen de correr ──────────────
if [ -n "$PREFIJO" ] && command -v aws >/dev/null 2>&1; then
  paso "1/3 · vaciando los servicios"
  n=0
  for cl in c3 c4 orq; do
    for s in $(aws ecs list-services --cluster "$PREFIJO-$cl" --region "$REGION" \
                 --query 'serviceArns[]' --output text 2>/dev/null | tr '\t' '\n' | grep . || true); do
      aws ecs update-service --cluster "$PREFIJO-$cl" --service "$s" \
        --desired-count 0 --region "$REGION" >/dev/null 2>&1 && n=$((n + 1))
    done
  done
  if [ "$n" != "0" ]; then
    echo "  $n servicio(s) a desired_count=0"
    # Esperar a que drenen. Sin esto el apply borraria los endpoints con tareas
    # todavia vivas, que es justo lo que este bloque evita.
    for _ in $(seq 1 40); do
      vivas=0
      for cl in c3 c4 orq; do
        t=$(aws ecs list-tasks --cluster "$PREFIJO-$cl" --region "$REGION" \
              --desired-status RUNNING --query 'length(taskArns)' --output text 2>/dev/null)
        case "$t" in ''|*[!0-9]*) t=0 ;; esac
        vivas=$((vivas + t))
      done
      [ "$vivas" = "0" ] && break
      echo "  esperando · $vivas tarea(s) todavia corriendo"
      sleep 15
    done
    verde "  computo a cero"
  else
    echo "  no habia servicios que vaciar"
  fi
fi

# ── 2/3 · el apply, que ya solo tiene que borrar cosas paradas ──────────────
paso "2/3 · apply"
fijar_perilla 0
$TF apply -input=false -auto-approve

paso "3/3 · guardar referencia"
guardar_docs
verde "$ESC apagado — computo y endpoints a cero. Red, llaves, colas y datos intactos."
