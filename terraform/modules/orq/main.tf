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

# ── Cloud Map · orq.poc.local ────────────────────────────────────────────
#
# El orquestador no necesita ser descubierto por nadie: es el que llama, no el
# llamado. Existe por una razon operativa — que el tunel del bastion pueda
# apuntar a un NOMBRE.
#
# La IP de una task de Fargate cambia cada vez que se reemplaza, y con ella
# cualquier comando que la tuviera escrita. Con el registro, el destino del
# tunel es siempre `orq.poc.local` y lo resuelve el bastion.
#
# Vive en la zona de C3 porque el orquestador vive en la VPC de C3.
resource "aws_service_discovery_service" "driver" {
  name = "orq"

  dns_config {
    namespace_id = var.namespace_id
    dns_records {
      ttl  = 10
      type = "A"
    }
    routing_policy = "MULTIVALUE"
  }

  tags = { Domain = "orq", Track = "O" }
}

resource "aws_ecs_task_definition" "driver" {
  family                   = "${var.name_prefix}-orq-driver"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"

  # ── 2 vCPU y 8 GiB · dimensionado para ~3.000 req/s ─────────────────────
  #
  # ⚠ LA CPU SE QUEDA EN 2, Y NO ES POR AHORRAR. Por peticion el driver hace
  #   ~50-80 us de JavaScript -elegir plantilla, refrescar event_id, rpf_id,
  #   sequence y occurred_at, JSON.stringify de ~3 KB, y el envio por undici-.
  #   A 3.000 req/s son 15-25% de UN core. Y Node es de un solo hilo: el
  #   segundo core ya lo ocupan el GC y el threadpool de libuv. Un tercero y un
  #   cuarto estarian ociosos y facturando.
  #
  #   Si algun dia el driver acusa `descartados_retraso` a ritmo alto, el
  #   culpable NO es la CPU: es que el planificador no llega a despachar. Se
  #   arregla con concurrencia, no con vCPU.
  #
  # ── Por que 8 GiB y no 4 ────────────────────────────────────────────────
  #
  # No es undici ni el pool de plantillas -1.000 plantillas son 2,9 MB-. Es EL
  # MANIFIESTO de O-08, que guarda un objeto por expediente para poder
  # responder P4.
  #
  # Con `eventos_por_hilo: 1` cada evento es su propio expediente. A 3.000 ev/s
  # son 3.000 expedientes/s: una corrida de 30 minutos son 5,4 millones de
  # filas, del orden de 1,2 GB. Con 4 GiB el techo de heap de V8 eran 2.096 MB
  # -medido en la task: 4.789 MB visibles, 2.096 de heap- y se iba justo.
  #
  # ⚠ Y ANTES DE LA MEMORIA SE TOPA CON `ORQ_MANIFIESTO_TOPE` (200.000 por
  #   defecto): a 3.000 ev/s con eventos_por_hilo=1 se alcanza EN 67 SEGUNDOS y
  #   el manifiesto sale con `truncado: true`. Subirlo es obligatorio para una
  #   corrida larga, o `eventos_por_hilo: 10` para dividir los expedientes por
  #   diez. La memoria de aqui no arregla eso: solo evita que ademas reviente.
  cpu    = 2048
  memory = 8192

  execution_role_arn = var.rol_ejecucion_arn
  task_role_arn      = var.rol_task_arn

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
    name      = "driver"
    image     = var.imagen_driver
    essential = true

    portMappings = [{ containerPort = 9090, protocol = "tcp" }] # O-07 /status

    environment = [
      # ── Los destinos ──
      #
      # La lista la conoce Terraform: es el MISMO for_each que crea los
      # tenants. El `config/tenants.yaml` horneado en la imagen es el ejemplo
      # de desarrollo -localhost:3001- y aca dentro no resuelve nada.
      #
      # Va con la misma forma que el YAML y pasa por el mismo validador. Un
      # formato distinto para lo mismo solo sirve para que uno de los dos se
      # quede sin ejercitar.
      {
        name = "ORQ_TENANTS_JSON"
        value = jsonencode({
          tenants = [
            for t, host in var.api_hosts : { id = "tenant-${t}", url = "http://${host}:8080" }
          ]
        })
      },

      # ── El perfil NO se inyecta ──
      #
      # Sigue siendo el YAML horneado en la imagen. O-01 quiere la forma de la
      # prueba en datos, y `POST /batch` la sobreescribe por corrida -ritmo,
      # duracion, reparto, llegadas- sin desplegar nada. Fijarla aca en
      # variables de entorno la congelaria en la task definition: cada cambio
      # de perfil seria un `terraform apply` y una revision nueva.
      #
      # Por eso tampoco estan LAZO, DISTRIBUCION_TENANT ni HTTP_TIMEOUT_MS: el
      # codigo no los lee. Lazo abierto (O-02) no es una perilla, es como esta
      # escrito el planificador; zipf (O-03), poisson (O-04) y el timeout
      # (O-05) viven en `config/perfil.yaml` y en el cuerpo del batch.
      { name = "ORQ_PORT", value = "9090" },

      # ── El heap de V8, explicito ──
      #
      # Node NO usa toda la memoria del contenedor para el heap: la deriva de
      # lo que ve, y da menos de la mitad. Medido en la task de 4 GiB: 4.789 MB
      # visibles y 2.096 MB de limite de heap.
      #
      # Sin fijarlo, el fallo es `heap out of memory` CON MEMORIA LIBRE en el
      # contenedor — y se depura mirando al sitio equivocado, porque las
      # metricas de la task dicen que sobra memoria.
      #
      # 6.144 de 8.192 deja ~2 GiB para el resto del proceso: los buffers de
      # undici, los sockets y lo que V8 no cuenta como heap.
      { name = "NODE_OPTIONS", value = "--max-old-space-size=6144" },
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
    subnets         = var.subnets_app
    security_groups = [var.sg_id]

    # Nunca publica. Las corridas se lanzan con curl a traves del tunel del
    # bastion, que resuelve `orq.poc.local` por Cloud Map — asi el destino no
    # depende de una IP que caduca en cada reemplazo de la task.
    assign_public_ip = false
  }

  service_registries {
    registry_arn = aws_service_discovery_service.driver.arn
  }

  # La puerta de servicio, y aca es imprescindible: es por donde se lanza la
  # corrida. Ver modules/security/exec.tf.
  enable_execute_command = true

  enable_ecs_managed_tags = true
  propagate_tags          = "SERVICE"
  tags                    = { Domain = "orq", Track = "O" }
}
