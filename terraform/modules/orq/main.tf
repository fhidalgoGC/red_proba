# ── ORQ · El driver de carga ─────────────────────────────────────────────
#
# ES ANDAMIO. Existe solo para la prueba y desaparece con ella. Que no se
# cite despues como parte del diseno del producto.
#
# No se conecta a C4 en absoluto. Si necesita verificar lo que llego, lee
# metricas, no la cola.

data "aws_region" "actual" {}

resource "aws_cloudwatch_log_group" "driver" {
  name              = "/ecs/${var.name_prefix}/orq-driver"
  retention_in_days = var.log_retention_days
  tags              = { Domain = "orq", Track = "O" }
}

resource "aws_ecs_task_definition" "driver" {
  family                   = "${var.name_prefix}-orq-driver"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 2048
  memory                   = 4096
  execution_role_arn       = var.rol_ejecucion_arn
  task_role_arn            = var.rol_task_arn

  container_definitions = jsonencode([{
    name      = "driver"
    image     = var.imagen_driver
    essential = true

    portMappings = [{ containerPort = 9090, protocol = "tcp" }] # O-07 /status

    environment = [
      # La lista de destinos. El driver hace 50 req/s -una por tenant-,
      # cada una pidiendo ~40 eventos. El orquestador NUNCA es el cuello
      # de botella: la asimetria es el punto.
      { name = "TENANT_HOSTS", value = join(",", values(var.api_hosts)) },
      { name = "PERFIL_PATH", value = "/etc/orq/perfil.yaml" },
      { name = "STATUS_PORT", value = "9090" },
      # O-02 · Lazo ABIERTO. Dispara segun el reloj, no segun las
      # respuestas. En lazo cerrado un sistema lento recibe menos carga y
      # se ve sano: es omision coordinada, y es la forma mas comun de que
      # una prueba de carga mienta.
      { name = "LAZO", value = "abierto" },
      { name = "DISTRIBUCION_TENANT", value = "zipf" },     # O-03
      { name = "DISTRIBUCION_LLEGADA", value = "poisson" }, # O-04
      { name = "HTTP_TIMEOUT_MS", value = "3000" },         # O-05
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.driver.name
        "awslogs-region"        = data.aws_region.actual.region
        "awslogs-stream-prefix" = "driver"
      }
    }
  }])

  tags = { Domain = "orq", Track = "O" }
}

resource "aws_ecs_service" "driver" {
  name            = "${var.name_prefix}-orq-driver"
  cluster         = var.cluster_arn
  task_definition = aws_ecs_task_definition.driver.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.subnets_app
    security_groups  = [var.sg_id]
    assign_public_ip = false
  }

  enable_ecs_managed_tags = true
  propagate_tags          = "SERVICE"
  tags                    = { Domain = "orq", Track = "O" }
}
