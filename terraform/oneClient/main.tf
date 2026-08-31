# ══════════════════════════════════════════════════════════════════════════
#  oneClient — 1 tenant. Prueba de humo del camino completo.
#
#  Mismo codigo que 50client: los dos son root modules delgados sobre
#  ../modules. Lo unico que cambia es var.tenants. Si el codigo divergiera,
#  lo que validas con 1 dejaria de ser lo que corres con 50.
# ══════════════════════════════════════════════════════════════════════════

data "aws_caller_identity" "actual" {}

locals {
  # Con desired_count=0 nada arranca, asi que la imagen puede no existir
  # todavia. Es lo que permite aplicar la infra antes de escribir los
  # contenedores.
  imagenes = {
    api      = "${module.registry.urls["c3-api"]}:${var.imagen_tag}"
    consumer = "${module.registry.urls["c4-consumer"]}:${var.imagen_tag}"
    driver   = "${module.registry.urls["orq-driver"]}:${var.imagen_tag}"
  }

  # RDS no escala a cero: la unica forma de no pagarlo es destruirlo. Por
  # eso sigue la perilla igual que los endpoints, salvo que se pida
  # explicitamente que persista.
  rds_activo = var.rds_persistente ? true : var.desired_count > 0
}

# ── Red · T-02 ────────────────────────────────────────────────────────────
module "network" {
  source = "../modules/network"

  name_prefix = var.name_prefix
  cidr_c3     = var.cidr_c3
  cidr_c4     = var.cidr_c4
  az_count    = var.az_count

  # Por defecto los endpoints siguen a la perilla de encendido, para que
  # estar apagado cueste ~$0 en vez de ~$7,20/dia. Se puede forzar con
  # var.endpoints_activos si hace falta dejarlos fijos.
  endpoints_activos = var.endpoints_activos != null ? var.endpoints_activos : var.desired_count > 0

  # El IGW y la ruta 0.0.0.0/0. Apagado, esta VPC no tiene salida a internet.
  acceso_externo = var.acceso_externo
}

# ── Seguridad · T-03 ──────────────────────────────────────────────────────
module "security" {
  source = "../modules/security"

  name_prefix = var.name_prefix
  tenants     = var.tenants
  vpc_ids     = module.network.vpc_ids
  vpc_cidrs   = module.network.vpc_cidrs

  # El security group del bastion y las reglas que le dejan alcanzar los
  # servicios y las bases. Nada de esto expone un puerto a internet.
  acceso_externo = var.acceso_externo
}

# ── Mensajeria · T-04 ─────────────────────────────────────────────────────
module "messaging" {
  source = "../modules/messaging"

  name_prefix  = var.name_prefix
  kms_cola_arn = module.security.kms_cola_arn
  rol_c3_id    = module.security.rol_c3_name
  rol_c4_id    = module.security.rol_c4_name
  rol_c3_arn   = module.security.rol_c3_arn
}

# ── Cola de DESARROLLO LOCAL · aparte de la del despliegue ────────────────
#
# ⚠ POR QUE EXISTE. `c3/.env` y `c4/.env` apuntan a una cola de verdad en AWS
#   —el pipeline local firma con KMS real y publica a SQS real, que es lo que
#   hace que la prueba local valga algo—. Con UNA sola cola, el C4 de tu
#   portatil y el C4 de Fargate son DOS CONSUMIDORES COMPETIDORES: SQS reparte
#   los mensajes entre los dos y cada uno se lleva la mitad.
#
#   Y no falla: cada mitad se descifra, se verifica y se persiste sin un solo
#   error. Simplemente el inbox de AWS acusa la mitad de los eventos, P4 da un
#   falso negativo y el hueco parece un problema de red o de la cola.
#
#   Medido: 105 eventos publicados, 56 en el inbox de C4 en AWS y 49 en el
#   `rpf_c4` local. Las metricas de la cola decian 105 enviados, 105 recibidos
#   y 105 borrados — porque los 105 SI se entregaron, solo que a dos sitios.
#
# La cola local es identica en configuracion a la del despliegue: mismo dedup
# por grupo, mismo cifrado, misma DLQ, mismo visibility timeout. Tiene que
# serlo, o lo que pruebas en local no es lo que corre en AWS.

module "messaging_local" {
  count  = var.cola_local ? 1 : 0
  source = "../modules/messaging"

  name_prefix  = "${var.name_prefix}-local"
  kms_cola_arn = module.security.kms_cola_arn
  rol_c3_id    = module.security.rol_c3_name
  rol_c4_id    = module.security.rol_c4_name
  rol_c3_arn   = module.security.rol_c3_arn

  # Aca publica y consume tu usuario, no el rol de una task. Y no es opcional:
  # las politicas de identidad del modulo son inline y con nombre fijo sobre los
  # MISMOS roles, asi que la segunda instancia sobrescribiria a la primera. Ver
  # la variable.
  permisos_de_task = false
}

# ── Registro de imagenes ──────────────────────────────────────────────────
module "registry" {
  source      = "../modules/registry"
  name_prefix = var.name_prefix
  # Ya no hace falta una imagen de Postgres: la base es RDS.
  repos = ["c3-api", "c4-consumer", "orq-driver"]
}

# ── Clusters ──────────────────────────────────────────────────────────────
resource "aws_ecs_cluster" "c3" {
  name = "${var.name_prefix}-c3"
  setting {
    name  = "containerInsights"
    value = "disabled" # M-04: medir no debe perturbar lo medido, y cuesta
  }
  tags = { Domain = "c3", Track = "T" }
}

resource "aws_ecs_cluster" "c4" {
  name = "${var.name_prefix}-c4"
  setting {
    name  = "containerInsights"
    value = "disabled"
  }
  tags = { Domain = "c4", Track = "T" }
}

# El cluster de ORQ es una agrupacion LOGICA, no una frontera de red: sus
# tareas corren en las subnets de C3. Sigue separado para que los logs, las
# metricas y el apagado del arnes no se mezclen con los del participante.
resource "aws_ecs_cluster" "orq" {
  name = "${var.name_prefix}-orq"
  setting {
    name  = "containerInsights"
    value = "disabled"
  }
  tags = { Domain = "orq", Track = "T" }
}

# ── Credenciales de Postgres ──────────────────────────────────────────────
#
# Una sola contrasena compartida. El doc lo permite explicitamente ("uno
# por tenant, o uno solo si la PoC no ejercita eso") y a 50 tenants ahorra
# ~$19,60/mes en Secrets Manager.
#
# Ademas HACE MAS VISIBLE la prueba de aislamiento de D-02: con contrasenas
# distintas, un SG mal asignado daria "password authentication failed" y
# podria confundirse con un problema de credenciales. Con la misma clave,
# si el aislamiento esta roto el 'select 1' simplemente FUNCIONA — y eso no
# se puede malinterpretar.

resource "random_password" "db" {
  length = 32
  # RDS rechaza / @ " y espacios en la contrasena maestra, y las URLs de
  # conexion de Postgres se llevan mal con simbolos. Solo alfanumerico.
  special = false
}

resource "aws_secretsmanager_secret" "db" {
  name = "${var.name_prefix}-db-password"

  # ⚠ 0 = borrado inmediato. Por defecto son 7-30 dias de espera, y en ese
  #   plazo NO se puede recrear un secreto con el mismo nombre: el
  #   siguiente apply falla con "already scheduled for deletion".
  #   Es una de las cosas que rompen el destroy (T-08).
  recovery_window_in_days = 0

  tags = { Domain = "shared", Track = "T" }
}

resource "aws_secretsmanager_secret_version" "db" {
  secret_id     = aws_secretsmanager_secret.db.id
  secret_string = random_password.db.result
}

# ── Tenants · T-05 ────────────────────────────────────────────────────────
module "tenant" {
  source = "../modules/tenant"

  name_prefix = var.name_prefix
  tenants     = var.tenants

  cluster_arn      = aws_ecs_cluster.c3.arn
  subnets_app      = module.network.subnets_app["c3"]
  subnets_datos    = module.network.subnets_datos["c3"]
  sg_tenant_ids    = module.security.sg_tenant_ids
  namespace_id     = module.network.namespace_c3_id
  namespace_nombre = module.network.namespace_c3_nombre

  rol_ejecucion_arn = module.security.rol_ejecucion_arn
  rol_task_arn      = module.security.rol_c3_arn

  imagen_api = local.imagenes.api

  db_password_secret_arn = aws_secretsmanager_secret.db.arn
  db_password            = random_password.db.result
  db_subnet_group        = module.network.db_subnet_groups["c3"]

  rds_activo         = local.rds_activo
  rds_instance_class = var.rds_class_tenant
  rds_engine_version = var.rds_engine_version
  rds_storage_gb     = var.rds_storage_gb

  kms_firma_arn    = module.security.kms_firma_arn
  kms_hmac_arn     = module.security.kms_hmac_arn
  kms_mensajes_arn = module.security.kms_mensajes_arn
  cola_url         = module.messaging.cola_url

  desired_count      = var.desired_count
  log_retention_days = var.log_retention_days

  # IP publica en la task (:8080) y endpoint publico en su RDS (:5432).
  acceso_externo = var.acceso_externo
}

# ── C4 · T-06 ─────────────────────────────────────────────────────────────
module "c4" {
  source = "../modules/c4"

  name_prefix   = var.name_prefix
  cluster_arn   = aws_ecs_cluster.c4.arn
  subnets_app   = module.network.subnets_app["c4"]
  subnets_datos = module.network.subnets_datos["c4"]
  sg_id         = module.security.sg_c4_id

  rol_ejecucion_arn = module.security.rol_ejecucion_arn
  rol_task_arn      = module.security.rol_c4_arn

  imagen_consumer = local.imagenes.consumer

  db_password_secret_arn = aws_secretsmanager_secret.db.arn
  db_password            = random_password.db.result
  db_subnet_group        = module.network.db_subnet_groups["c4"]

  rds_activo         = local.rds_activo
  rds_instance_class = var.rds_class_c4
  rds_engine_version = var.rds_engine_version
  rds_storage_gb     = var.rds_storage_gb

  kms_firma_arn    = module.security.kms_firma_arn
  kms_mensajes_arn = module.security.kms_mensajes_arn
  cola_url         = module.messaging.cola_url
  dlq_url          = module.messaging.dlq_url

  # ⚠ EL UNICO SERVICIO QUE NO RECIBE `desired_count` A SECAS.
  #
  # `desired_count` sigue siendo el interruptor de T-07: si esta en 0, C4 no
  # corre, punto. Pero cuando esta encendido, cuantas replicas hay lo decide
  # `c4_replicas` — porque C4 es lo unico de la PoC que se puede escalar
  # horizontal sin cambiar lo que se mide. Ver la variable.
  desired_count      = var.desired_count > 0 ? var.c4_replicas : 0
  log_retention_days = var.log_retention_days

  # IP publica en la task (:3003), endpoint publico en su RDS (:5432) y
  # C4_HEALTH_HOST=0.0.0.0 — un proceso en loopback no se alcanza desde fuera.
  acceso_externo = var.acceso_externo

  # El ritmo del consumidor. Ver las variables: la concurrencia no rompe el
  # orden, pero `lote_transaccion` SI cambia lo que mide P1.
  concurrencia     = var.c4_concurrencia
  lote_transaccion = var.c4_lote_transaccion
}

# ── Orquestador · T-06 ────────────────────────────────────────────────────
module "orq" {
  source = "../modules/orq"

  name_prefix = var.name_prefix
  cluster_arn = aws_ecs_cluster.orq.arn
  # El orquestador corre DENTRO de la VPC de C3: sin peering que mantener y
  # resolviendo api-NN.poc.local directo. Lo que lo separa de los tenants es
  # su security group, igual que un tenant se separa de otro.
  subnets_app = module.network.subnets_app["c3"]
  sg_id       = module.security.sg_orq_id

  rol_ejecucion_arn = module.security.rol_ejecucion_arn
  rol_task_arn      = module.security.rol_orq_arn

  imagen_driver = local.imagenes.driver
  api_hosts     = module.tenant.api_hosts

  # Se registra como `orq.poc.local` en la zona de C3, para que el tunel del
  # bastion apunte a un nombre y no a una IP que caduca.
  namespace_id = module.network.namespace_c3_id

  desired_count      = var.desired_count
  log_retention_days = var.log_retention_days
}

# ── Bastiones · UNO POR VPC, y solo con acceso_externo ────────────────────
#
# ⚠ DOS, no uno, y no es una eleccion de diseno: la RDS de C4 vive en la VPC de
#   C4 y NO HAY RUTA entre C3 y C4. Un bastion en C3 no la alcanza. Eso es
#   exactamente el invariante que la PoC demuestra — si un dia UN solo bastion
#   llegara a las dos, es que alguien abrio un camino que no deberia existir.
#
# El de C3 alcanza el orquestador, los N API y las N bases de los tenants: los
# 50 viven en esa VPC, asi que el coste es el mismo con 1 tenant que con 200.
#
# Cuestan ~$0,24/dia cada uno. Se van enteros con `--sin-acceso-externo`.

module "bastion_c3" {
  count  = var.acceso_externo ? 1 : 0
  source = "../modules/bastion"

  name_prefix = var.name_prefix
  vpc         = "c3"
  subnet_id   = module.network.subnets_app["c3"][0]
  sg_id       = module.security.sg_bastion_ids["c3"]
}

module "bastion_c4" {
  count  = var.acceso_externo ? 1 : 0
  source = "../modules/bastion"

  name_prefix = var.name_prefix
  vpc         = "c4"
  subnet_id   = module.network.subnets_app["c4"][0]
  sg_id       = module.security.sg_bastion_ids["c4"]
}
