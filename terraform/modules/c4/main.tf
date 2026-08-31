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

  # NUNCA publica. Aca vive el inbox, que es la respuesta a P4: darle endpoint
  # publico seria lo mas delicado de toda la PoC. Desde fuera se alcanza por el
  # bastion de la VPC de C4 (modules/bastion).
  publicly_accessible = false
  multi_az            = false

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

  # ── 2 vCPU y 4 GiB · dimensionado para ~3.000 msg/s ─────────────────────
  #
  # C4 recibe TODO el trafico agregado: 50 tenants a 40-60 ev/s cada uno caen
  # aqui. Por eso lleva el doble que un tenant, igual que el orquestador.
  #
  # ⚠ 2 vCPU Y NO 4, y la razon no es el precio. Node es de UN SOLO HILO: el
  #   descifrado, la verificacion Ed25519 y el JCS corren todos en el bucle de
  #   eventos. El segundo core lo aprovechan el GC y el threadpool de libuv
  #   -el TLS hacia Postgres y hacia SQS-. El tercero y el cuarto no los
  #   tocaria nadie: se pagarian enteros para estar ociosos.
  #
  # ⚠ LOS 4 GiB SON POR EL HEAP, NO POR LA MEMORIA. Medido en la task de 2 GiB:
  #   49 MB de RSS con el consumidor corriendo. Sobra memoria de largo. Pero
  #   V8 fija su limite de heap en la MITAD de lo que ve el proceso: con 2 GiB
  #   de contenedor son ~1 GiB de heap, y con 4 GiB son ~2 GiB. El fallo que
  #   esto evita es un `heap out of memory` con memoria libre en el contenedor,
  #   que es de los que se depuran mirando al sitio equivocado.
  #
  # ⚠ ESTO NO SUBE EL RITMO POR SI SOLO. El lazo del consumidor procesa los
  #   mensajes DE UNO EN UNO -un `for` con `await` dentro, sin Promise.all- y
  #   espera ~8 ms al INSERT de cada uno. Eso son ~80 msg/s por task, y mas
  #   vCPU no acelera una espera. Para acercarse a 3.000 hacen falta tres
  #   cambios en el codigo -procesar el lote en paralelo, varios lazos de
  #   recepcion concurrentes e INSERT multifila- y varias replicas.
  cpu    = 2048
  memory = 4096

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
      { name = "KMS_ENCRYPT_KEY_ID", value = var.kms_mensajes_arn },
      # LISTA BLANCA de llaves de firma aceptadas, separadas por coma.
      #
      # No es "la llave con la que verificar": el `key_id` lo escribe quien
      # publica, y si C4 fuera a buscar la llave que el sobre pide, cualquiera
      # con permiso de publicar podria firmar con SU llave y la firma
      # verificaria. Sin esta lista, la firma prueba integridad pero NO autoria.
      #
      # Solo hace falta leer la PUBLICA: kms:Sign no esta en el rol de C4, y la
      # key policy de la llave Ed25519 se lo niega explicitamente.
      { name = "C4_LLAVES_FIRMA", value = var.kms_firma_arn },
      { name = "SQS_BATCH_SIZE", value = "10" },
      { name = "SQS_WAIT_SECONDS", value = "20" },

      # ── Ritmo ──
      #
      # SQS entrega 10 mensajes por llamada como MAXIMO, asi que subir
      # SQS_BATCH_SIZE no es alternativa: para 3.000 msg/s hacen falta 300
      # llamadas/s, y un lazo con una sola en vuelo llega a ~40.
      #
      # `C4_CONCURRENCIA` son N invocaciones del mismo lazo -no hilos-, que se
      # solapan porque un ciclo se pasa ~40 de cada 50 ms esperando a la red.
      # No rompe el orden: mientras un mensaje de un MessageGroupId este en
      # vuelo, SQS no entrega otro de ese grupo a nadie.
      { name = "C4_CONCURRENCIA", value = tostring(var.concurrencia) },

      # ⚠ El pool tiene que dar para `concurrencia × 10` conexiones. Si se
      #   queda corto NO falla: las transacciones esperan turno, el ritmo no
      #   mejora y no hay un solo log que lo explique. C4 grita al arrancar si
      #   no cuadra.
      { name = "C4_BD_POOL", value = tostring(var.concurrencia * 10) },

      # ⚠ CAMBIA LO QUE MIDE P1. Con un COMMIT por lote los N eventos se
      #   persisten en el mismo instante -es la verdad- pero e9→e10 pasa a
      #   medir el LOTE y no el evento. Encenderlo es una decision de la
      #   corrida; no se pueden comparar dos corridas con valores distintos y
      #   llamar a la diferencia una mejora de latencia.
      { name = "C4_LOTE_TRANSACCION", value = tostring(var.lote_transaccion) },
      # G-09 · el health. Sigue SIN portMappings y sin balanceador: escucha en
      # 127.0.0.1, dentro del contenedor, y el unico que lo consulta es el
      # healthCheck de abajo. C4 no expone nada a la red — el invariante de
      # D-03 no se toca.
      { name = "C4_PORT", value = "3003" },
      # ⚠ 127.0.0.1 es lo correcto: el health es para quien opera, no para la
      # red, y el unico que lo consulta es el healthCheck de esta misma task.
      #
      # Con `acceso_externo` pasa a 0.0.0.0 porque un tunel o una IP publica
      # NO alcanzan un proceso que escucha en loopback — y entonces el
      # /health de C4 seria el unico endpoint inalcanzable de los tres.
      { name = "C4_HEALTH_HOST", value = var.acceso_externo ? "0.0.0.0" : "127.0.0.1" },
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
    subnets         = var.subnets_app
    security_groups = [var.sg_id]

    # Nunca publica. C4 no expone nada a internet: su /health se consulta por
    # el bastion de esta VPC, y su unica entrada de datos sigue siendo la cola.
    assign_public_ip = false
  }

  # La puerta de servicio: es lo que permite volcar el inbox para responder
  # P4 sin abrirle a C4 una sola ruta de red. Ver modules/security/exec.tf.
  enable_execute_command = true

  enable_ecs_managed_tags = true
  propagate_tags          = "SERVICE"
  tags                    = { Domain = "c4", Track = "G" }
}
