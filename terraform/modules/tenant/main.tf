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
  publicly_accessible    = false
  multi_az               = false # PoC: Single-AZ, la mitad de precio

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

  container_definitions = jsonencode([{
    name      = "api"
    image     = var.imagen_api
    essential = true

    portMappings = [{ containerPort = 8080, protocol = "tcp" }]

    # ── Contrato de arranque (CLAUDE.md) ──
    # Una sola imagen para los 50; todo lo que cambia son estas variables.
    environment = [
      { name = "TENANT_ID", value = each.key },
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
    subnets          = var.subnets_app
    security_groups  = [var.sg_tenant_ids[each.key]]
    assign_public_ip = false
  }

  service_registries {
    registry_arn = aws_service_discovery_service.api[each.key].arn
  }

  enable_ecs_managed_tags = true
  propagate_tags          = "SERVICE"

  tags = { Domain = "c3", Tenant = each.key, Track = "C" }
}

data "aws_region" "actual" {}
