# ── C4 · El operador neutro ──────────────────────────────────────────────
#
# Consume de la cola, descifra, verifica y persiste. Termina cuando el
# evento queda en el Postgres de C4 — ese COMMIT es e10, el final de la
# medicion.
#
# INVARIANTE: su task role no tiene kms:Sign, y la key policy de la llave
# Ed25519 se lo niega explicitamente. Si kms:Sign aparece aca, el Proof
# Ledger perdio su valor probatorio.

data "aws_region" "actual" {}

resource "aws_cloudwatch_log_group" "consumer" {
  name              = "/ecs/${var.name_prefix}/c4-consumer"
  retention_in_days = var.log_retention_days
  tags              = { Domain = "c4", Track = "G" }
}





# ── Postgres de C4 · RDS ─────────────────────────────────────────────────
#
# Aca vive el inbox, y su COMMIT es e10: el final de la medicion. Que
# sobreviva a un reinicio del consumidor es lo que permite responder P4
# sin asterisco.
#
# Recibe TODO el trafico -2.000 ev/s en 50client, no 40 como un tenant-,
# asi que lleva una clase mas grande.

resource "aws_db_instance" "esta" {
  count = var.rds_activo ? 1 : 0

  identifier     = "${var.name_prefix}-c4-db"
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
  vpc_security_group_ids = [var.sg_id]
  publicly_accessible    = false
  multi_az               = false

  skip_final_snapshot     = true
  deletion_protection     = false
  backup_retention_period = 0

  performance_insights_enabled = false
  monitoring_interval          = 0
  auto_minor_version_upgrade   = false
  apply_immediately            = true

  tags = { Name = "${var.name_prefix}-c4-db", Domain = "c4", Track = "G" }
}

resource "aws_ecs_task_definition" "consumer" {
  family                   = "${var.name_prefix}-c4-consumer"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 1024
  memory                   = 2048
  execution_role_arn       = var.rol_ejecucion_arn
  task_role_arn            = var.rol_task_arn

  container_definitions = jsonencode([{
    name      = "consumer"
    image     = var.imagen_consumer
    essential = true

    environment = [
      { name = "SQS_QUEUE_URL", value = var.cola_url },
      { name = "SQS_DLQ_URL", value = var.dlq_url },
      { name = "DB_HOST", value = try(aws_db_instance.esta[0].address, "rds-apagado") },
      { name = "DB_PORT", value = "5432" },
      { name = "DB_NAME", value = "poc" },
      { name = "DB_USER", value = "app" },
      { name = "KMS_DECRYPT_KEY_ID", value = var.kms_mensajes_arn },
      # Solo el ARN de la llave de firma para leer la PUBLICA y verificar.
      # kms:Sign no esta en el rol, y la key policy lo niega.
      { name = "KMS_VERIFY_KEY_ID", value = var.kms_firma_arn },
      { name = "SQS_BATCH_SIZE", value = "10" },
      { name = "SQS_WAIT_SECONDS", value = "20" },
      # G-09 · el health. Sigue SIN portMappings y sin balanceador: escucha en
      # 127.0.0.1, dentro del contenedor, y el unico que lo consulta es el
      # healthCheck de abajo. C4 no expone nada a la red — el invariante de
      # D-03 no se toca.
      { name = "C4_PORT", value = "3003" },
      { name = "C4_HEALTH_HOST", value = "127.0.0.1" },
    ]
    secrets = [{ name = "DB_PASSWORD", valueFrom = var.db_password_secret_arn }]

    # ⚠ Se comprueba `ok:true`, no el codigo HTTP. El endpoint contesta 200
    # tambien cuando la base esta caida, con `ok:false` dentro: un health que
    # respondiera 200 a secas dejaria la task en verde mientras C4 saca
    # mensajes de la cola sin poder persistirlos, y P4 daria de menos sin un
    # solo error.
    #
    # Con `node -e` y no con curl: la imagen no trae curl, y anadirlo solo para
    # esto engorda el contenedor.
    healthCheck = {
      command = [
        "CMD-SHELL",
        "node -e \"fetch('http://127.0.0.1:3003/health').then(r=>r.json()).then(j=>process.exit(j.ok?0:1)).catch(()=>process.exit(1))\""
      ]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 20
    }

    stopTimeout = 30

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.consumer.name
        "awslogs-region"        = data.aws_region.actual.region
        "awslogs-stream-prefix" = "consumer"
      }
    }
  }])

  tags = { Domain = "c4", Track = "G" }
}

resource "aws_ecs_service" "consumer" {
  name            = "${var.name_prefix}-c4-consumer"
  cluster         = var.cluster_arn
  task_definition = aws_ecs_task_definition.consumer.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.subnets_app
    security_groups  = [var.sg_id]
    assign_public_ip = false
  }

  enable_ecs_managed_tags = true
  propagate_tags          = "SERVICE"
  tags                    = { Domain = "c4", Track = "G" }
}
