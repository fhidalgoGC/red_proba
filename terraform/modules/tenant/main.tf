# ── T-05 · Modulo de tenant, parametrizado ───────────────────────────────
#
# for_each sobre la lista de tenants. NUNCA 50 bloques copiados.
# oneClient pasa ["01"], 50client pasa ["01".."50"]. Mismo codigo.

locals {
  tenants = toset(var.tenants)
}

# ── Log groups · uno por service ─────────────────────────────────────────
# Retencion de 1 dia. Obligatorio: cuando un evento no verifique, el log es
# lo unico que dice por que.
#
# ⚠ Los log groups se van con el destroy y NO se recuperan. La exportacion
#   a S3 tiene que ocurrir ANTES. Ver scripts/destruir.sh.

resource "aws_cloudwatch_log_group" "api" {
  for_each          = local.tenants
  name              = "/ecs/${var.name_prefix}/api-${each.key}"
  retention_in_days = var.log_retention_days
  tags              = { Domain = "c3", Tenant = each.key, Track = "C" }
}


# ── Cloud Map · api-NN.poc.local ─────────────────────────────────────────
# Solo el API. La base no entra aca: RDS trae su propio endpoint DNS y es
# el que va en DB_HOST.

resource "aws_service_discovery_service" "api" {
  for_each = local.tenants
  name     = "api-${each.key}"

  dns_config {
    namespace_id = var.namespace_id
    dns_records {
      ttl  = 10
      type = "A"
    }
    routing_policy = "MULTIVALUE"
  }
  tags = { Domain = "c3", Tenant = each.key }
}


# ── Postgres · RDS ───────────────────────────────────────────────────────
#
# Una instancia por tenant. NO es un contenedor: si la tarea del API muere,
# la base y su outbox sobreviven. Eso es lo que hace posible demostrar Gap
# Detection de verdad y que P4 -conciliacion- no quede con asterisco.
#
# ⚠ RDS NO SE PUEDE ESCALAR A CERO. La perilla desired_count apaga tareas
#   de Fargate en segundos, pero con RDS la unica forma de no pagar es
#   destruir la instancia. Por eso RDS sigue la perilla igual que los
#   endpoints, y por eso apagar ahora BORRA LA BASE.
#
#   Si hace falta que los datos sobrevivan a un apagado, poner
#   var.rds_persistente = true y asumir el costo continuo.

resource "aws_db_instance" "esta" {
  for_each = var.rds_activo ? local.tenants : []

  identifier     = "${var.name_prefix}-db-${each.key}"
  engine         = "postgres"
  engine_version = var.rds_engine_version
  instance_class = var.rds_instance_class

  allocated_storage = var.rds_storage_gb
  storage_type      = "gp3"
  storage_encrypted = true

  db_name  = "poc"
  username = "app"
  password = var.db_password

  db_subnet_group_name   = var.db_subnet_group
  vpc_security_group_ids = [var.sg_tenant_ids[each.key]]

  # NUNCA publica, ni con acceso_externo. Con 50 tenants serian 50 endpoints
  # de base de datos en internet y 50 IPv4 a $0,12/dia = $6/dia solo en IPs.
  # El acceso desde fuera va por el bastion de la VPC (modules/bastion), que
  # cuesta lo mismo con 1 tenant que con 200.
  publicly_accessible = false
  multi_az            = false # PoC: Single-AZ, la mitad de precio

  # ── Que el destroy sea limpio y rapido ──
  # Sin esto, destroy exige un snapshot final que tarda y deja un
  # artefacto facturando que nadie recuerda borrar.
  skip_final_snapshot     = true
  deletion_protection     = false
  backup_retention_period = 0 # sin backups automaticos: es una PoC

  performance_insights_enabled = false
  monitoring_interval          = 0
  auto_minor_version_upgrade   = false
  apply_immediately            = true

  tags = { Name = "${var.name_prefix}-db-${each.key}", Domain = "c3", Tenant = each.key, Track = "C" }
}

# ── API · NestJS. El relay del outbox vive en ESTE mismo proceso ─────────
#
# No son dos contenedores ni dos services: el @Interval del relay corre
# dentro del proceso del API.

resource "aws_ecs_task_definition" "api" {
  for_each = local.tenants

  family                   = "${var.name_prefix}-api-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 1024
  memory                   = 2048
  execution_role_arn       = var.rol_ejecucion_arn
  task_role_arn            = var.rol_task_arn

  # ── Arquitectura, declarada ──────────────────────────────────────────────
  #
  # Sin este bloque Fargate asume X86_64, y una imagen construida en un Mac
  # arm64 arranca y muere con «exec format error» — que en los logs de ECS
  # aparece como una tarea que reinicia en bucle, no como un error de build.
  #
  # ARM64 y no X86_64 por dos razones: es nativo en las maquinas donde se
  # construye (sin emulacion, sin `--platform`) y Fargate lo cobra ~20% mas
  # barato. Nada de la PoC tiene modulos nativos — pg, el SDK de AWS y Nest son
  # JavaScript puro—, asi que no hay nada que compilar por arquitectura.
  #
  # ⚠ Si algun dia esto se construye en un CI x86, hay que cambiar ESTE bloque
  #   o construir con `docker buildx build --platform linux/arm64`.
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  container_definitions = jsonencode([{
    name      = "api"
    image     = var.imagen_api
    essential = true

    portMappings = [{ containerPort = 8080, protocol = "tcp" }]

    # ── Contrato de arranque (CLAUDE.md) ──
    # Una sola imagen para los 50; todo lo que cambia son estas variables.
    environment = [
      # `tenant-01`, no `01`: es el mismo identificador que usa el
      # orquestador en ORQ_TENANTS_JSON y el que nombra los logs de los dos
      # lados. Con "01" a secas, `POST /batch {"client":"01"}` es ambiguo -el
      # API acepta tambien el indice- y los informes de C3 y del arnes no se
      # cruzan a simple vista.
      { name = "TENANT_ID", value = "tenant-${each.key}" },
      # Endpoint de RDS. Cuando rds_activo=false la instancia no existe
      # todavia: la task definition igual se crea -es gratis- con un
      # marcador, y al encender toma el endpoint real.
      { name = "DB_HOST", value = try(aws_db_instance.esta[each.key].address, "rds-apagado") },
      { name = "DB_PORT", value = "5432" },
      { name = "DB_NAME", value = "poc" },
      { name = "DB_USER", value = "app" },
      { name = "KMS_SIGN_KEY_ID", value = var.kms_firma_arn },
      { name = "KMS_HMAC_KEY_ID", value = var.kms_hmac_arn },
      { name = "KMS_ENCRYPT_KEY_ID", value = var.kms_mensajes_arn },
      { name = "SQS_QUEUE_URL", value = var.cola_url },
      { name = "OUTBOX_POLL_MS", value = "500" },
      { name = "OUTBOX_BATCH_SIZE", value = "10" },
      { name = "OUTBOX_MAX_ATTEMPTS", value = "10" },
      { name = "OUTBOX_BACKOFF_CAP_SEC", value = "300" },
      { name = "PORT", value = "8080" },
    ]

    secrets = [
      { name = "DB_PASSWORD", valueFrom = var.db_password_secret_arn },
    ]

    # C-08 · Health check real: el endpoint verifica la conexion a la base.
    # Si respondiera 200 siempre, no te enterarias de que una base murio.
    healthCheck = {
      command     = ["CMD-SHELL", "wget -qO- http://localhost:8080/health || exit 1"]
      interval    = 15
      timeout     = 5
      retries     = 3
      startPeriod = 60
    }

    # C-07 · Cierre ordenado. Fargate da 30 s tras el SIGTERM para terminar
    # la peticion en vuelo, dejar de tomar trabajo y cerrar el pool.
    stopTimeout = 30

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.api[each.key].name
        "awslogs-region"        = data.aws_region.actual.region
        "awslogs-stream-prefix" = "api"
      }
    }
  }])

  tags = { Domain = "c3", Tenant = each.key, Track = "C" }
}

resource "aws_ecs_service" "api" {
  for_each = local.tenants

  name            = "${var.name_prefix}-api-${each.key}"
  cluster         = var.cluster_arn
  task_definition = aws_ecs_task_definition.api[each.key].arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets         = var.subnets_app
    security_groups = [var.sg_tenant_ids[each.key]]

    # Nunca publica. El :8080 se alcanza desde fuera por el bastion de la VPC,
    # que llega a los 50 tenants sin una sola IP publica en las tasks.
    assign_public_ip = false
  }

  service_registries {
    registry_arn = aws_service_discovery_service.api[each.key].arn
  }

  # La puerta de servicio. Ver modules/security/exec.tf.
  enable_execute_command = true

  enable_ecs_managed_tags = true
  propagate_tags          = "SERVICE"

  tags = { Domain = "c3", Tenant = each.key, Track = "C" }
}

data "aws_region" "actual" {}
