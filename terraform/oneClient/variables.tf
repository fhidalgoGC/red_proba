variable "region" {
  type        = string
  description = "Region. us-west-2 es la configurada en la CLI de esta cuenta."
  default     = "us-west-2"
}

variable "project" {
  type    = string
  default = "rpf-proof-ledger"
}

variable "name_prefix" {
  type        = string
  description = "Prefijo de todos los nombres. Tambien aisla oneClient de 50client."
  default     = "rpf-one"
}

variable "run_id" {
  type        = string
  description = <<-D
    Identificador de corrida. Es la tag que permite decir "la corrida del
    martes costo $X" en vez de "agosto costo $Y".

    El costo ya facturado conserva el valor que la tag tenia en ese
    momento, asi que cambiarlo no reescribe el pasado ni recrea recursos.

    ⚠ Sin granularidad horaria -bloqueada por el payer- dos corridas el
      mismo dia no se separan. Una corrida de carga por dia.
  D
  default     = "2026-08-29-humo"
}

variable "owner" {
  type    = string
  default = "fhidalgo@grainchain.io"
}

# ── La unica diferencia real con 50client ────────────────────────────────
variable "tenants" {
  type        = list(string)
  description = "oneClient: un solo tenant. 50client pasa [\"01\" ... \"50\"]."
  default     = ["01"]
}

# ── CIDR ─────────────────────────────────────────────────────────────────
# Dos VPC: C3 -donde tambien corre el orquestador- y C4. Entre ellas no hay
# ninguna ruta; la cola es el unico canal.
#
# ⚠ La cuenta ya tiene 10.0.0.0/16 y 10.16.0.0/16 de otro equipo.
#   Arrancamos en 10.101 para no chocar.
variable "cidr_c3" {
  type    = string
  default = "10.101.0.0/16"
}
variable "cidr_c4" {
  type    = string
  default = "10.102.0.0/16"
}
variable "az_count" {
  type        = number
  description = "AZs por VPC (2). Cada interface endpoint cobra una ENI por AZ."
  default     = 2
}

# ── T-07 · La perilla de apagado ─────────────────────────────────────────
variable "desired_count" {
  type        = number
  description = <<-D
    0 = infraestructura creada, cero computo, cero pull de imagenes.
    1 = servicios corriendo.

    Con 0 se puede aplicar TODO antes de que existan los contenedores.
    Entre corridas se apaga con 0, no se destruye: deja de facturar en
    segundos y conserva red, llaves, colas y datos.
  D
  default     = 0
}

variable "c4_replicas" {
  type        = number
  description = <<-D
    Cuantos consumidores de C4 corren CUANDO el despliegue esta encendido.

    Es una perilla aparte de `desired_count` a proposito. `desired_count` es el
    interruptor de T-07 y lo comparten los TRES servicios: subirlo a 2 daria
    tambien 2 tasks por tenant y —lo que de verdad rompe— DOS ORQUESTADORES.
    Con dos, `orq.poc.local` resuelve a dos IPs: lanzarias el batch contra uno
    y pedirias el informe al otro, con 404 aleatorios y una carga ofrecida que
    no es la que crees.

    Aca escalar SI es seguro. C4 es un consumidor de cola: SQS FIFO no entrega
    un mismo `MessageGroupId` a dos consumidores a la vez, y con
    `eventos_por_hilo: 1` cada evento es su propio grupo — asi que N
    consumidores reparten el trabajo sin pisarse y sin romper el orden. El
    inbox ademas es idempotente por `payload_hash`.

    ⚠ MAS REPLICAS NO ARREGLAN EL LAZO. Hoy el consumidor procesa los mensajes
      de uno en uno y espera ~8 ms al INSERT de cada uno: ~80 msg/s por task.
      Dos replicas son ~160, no 3.000. Para eso hacen falta los tres cambios de
      codigo —lote en paralelo, varios lazos de recepcion e INSERT multifila—.

    ⚠ Y TODAS PEGAN A LA MISMA RDS. `db.t4g.medium` es de rafaga: a ritmo
      sostenido agota los creditos de CPU y se estrangula. El sintoma es que
      e9->e10 crece sin que crezca ningun otro tramo, y ningun error lo
      explica.
  D
  default     = 1

  validation {
    condition     = var.c4_replicas >= 1 && var.c4_replicas <= 20
    error_message = "Entre 1 y 20. Para apagar C4 usa desired_count = 0, que es el interruptor de T-07."
  }
}

variable "imagen_tag" {
  type        = string
  description = "Tag de las imagenes en ECR. 'humo' para las prestadas."
  default     = "humo"
}

variable "log_retention_days" {
  type    = number
  default = 1
}
variable "presupuesto_mensual_usd" {
  type        = string
  description = <<-D
    Umbral de alerta mensual. El baseline de la cuenta sin la PoC es
    ~$2,45/mes, asi que cualquier valor por encima de ~$20 significa que
    algo quedo prendido.
  D
  default     = "50"
}

variable "exportacion_retencion_dias" {
  type        = number
  description = "Dias que sobreviven los logs y tablas exportados a S3."
  default     = 30
}

variable "endpoints_activos" {
  type        = bool
  description = <<-D
    null  = siguen a desired_count (recomendado: apagado cuesta ~$0)
    true  = siempre encendidos, ~$7,20/dia con 2 AZ aunque no corra nada
    false = siempre apagados; las tareas NO pueden arrancar sin ellos
  D
  default     = null
}

# ── RDS ───────────────────────────────────────────────────────────────────
variable "rds_persistente" {
  type        = bool
  description = <<-D
    RDS no se puede escalar a cero: la unica forma de no pagarlo es
    destruir la instancia.

    false (defecto) → RDS sigue la perilla de encendido. Apagar borra la
                      base. Estar apagado sigue costando ~$0,15/dia.
    true            → la base existe siempre y sobrevive a los apagados,
                      pero cuesta ~$2,10/dia en oneClient aunque no corra
                      nada.
  D
  default     = false
}

variable "rds_class_tenant" {
  type        = string
  description = "Clase de la base de cada tenant. A 40 ev/s, micro alcanza."
  default     = "db.t4g.micro"
}

variable "rds_class_c4" {
  type        = string
  description = <<-D
    Clase de la base de C4. Recibe TODO el trafico -2.000 ev/s en
    50client, no 40 como un tenant-, asi que lleva mas.

    NOTA PARA 50client, no para el humo: la familia t4g es de RAFAGA.
    Funciona con creditos de CPU y al agotarlos se estrangula al baseline.
    Una corrida sostenida de 5 h a 2.000 ev/s los agota, y el sintoma es
    el mismo que el throttling de KMS: la latencia crece, el outbox se
    llena y NINGUN error lo explica.

    Si al medir 50client el intervalo e9->e10 -persistencia en C4- crece
    sin que crezcan los otros, sospechar de esto antes que del codigo, y
    pasar a db.m6g.large (2 vCPU sin rafaga, 8 GiB).
  D
  default     = "db.t4g.medium"
}

variable "acceso_externo" {
  type        = bool
  description = <<-D
    Crear UN BASTION POR VPC para poder llegar desde tu maquina a los endpoints
    y a las bases.

    ⚠ APAGADO POR DEFECTO, y la corrida de medicion de verdad se hace apagado.
      El informe tiene que decir con que valor se corrio.

    Que enciende:
      · un Internet Gateway por VPC y la ruta 0.0.0.0/0
      · un t4g.nano por VPC, gestionado por Session Manager
      · las reglas que dejan al bastion alcanzar 8080, 5432, 9090 y 3003

    Que NO expone: nada. El bastion no tiene reglas de entrada — se entra por
    Session Manager, que es una sesion SALIENTE autorizada por IAM. Las tasks
    siguen sin IP publica y las RDS sin endpoint publico. Por eso tampoco hace
    falta declarar tu IP.

    Que NO rompe: el invariante de que no hay camino entre C3 y C4. Hacen falta
    DOS bastiones precisamente porque uno no alcanza la otra VPC.

    Coste: ~$0,48/dia los dos, y es PLANO — el mismo con 1 tenant que con 200.
    Con IP publicas seria $0,60/dia con 1 tenant y $12,36/dia con 50.

    Uso:  sh terraform:deploy --acceso-externo   /   --sin-acceso-externo
          sh tunel --lista
  D
  default     = false
}

variable "c4_concurrencia" {
  type        = number
  description = "Lazos de recepcion por task de C4. Ver modules/c4/variables.tf."
  default     = 1
}

variable "c4_lote_transaccion" {
  type        = bool
  description = "Un COMMIT por lote en C4. ⚠ Cambia lo que mide P1."
  default     = false
}

variable "cola_local" {
  type        = bool
  description = <<-D
    Crear el par de colas de DESARROLLO LOCAL, aparte de las del despliegue.

    Cuestan ~$0: SQS se cobra por peticion y una cola parada no hace ninguna.
    Por eso NO siguen la perilla de encendido — apagar el despliegue no tiene
    por que dejarte sin entorno local.

    Ponerlo en false solo tiene sentido en una cuenta donde nadie desarrolle.
  D
  default     = true
}

variable "rds_engine_version" {
  type = string

  # ⚠ SOLO LA MAYOR, a proposito. Con una minor fija -"16.4"- el apply revienta
  # el dia que AWS la retira, y el error no dice "esta version ya no existe"
  # sino `InvalidParameterCombination: Cannot find version 16.4 for postgres`.
  # Paso: 16.4 desaparecio de us-west-2 y el encendido se cayo en la creacion de
  # las dos instancias, con toda la red ya creada.
  #
  # Con la mayor a secas RDS elige la ultima minor disponible al CREAR, y
  # `auto_minor_version_upgrade = false` la congela ahi: no hay deriva despues.
  # El provider de AWS acepta el prefijo y no lo marca como cambio.
  #
  # Para fijar una minor exacta -reproducir un comportamiento del motor-, poner
  # el numero completo y aceptar que caduca:
  #   aws rds describe-db-engine-versions --engine postgres --region us-west-2 \
  #     --query 'DBEngineVersions[].EngineVersion'
  default = "16"
}

variable "rds_storage_gb" {
  type        = number
  description = "20 GB es el minimo de RDS."
  default     = 20
}
