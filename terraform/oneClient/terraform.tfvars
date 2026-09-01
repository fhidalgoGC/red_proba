# ── oneClient · 1 tenant ──────────────────────────────────────────────────
#
# La UNICA diferencia con 50client. El resto del codigo es el mismo.
tenants = ["01"]

region      = "us-west-2"
name_prefix = "rpf-one"

# Identificador de corrida. Bumpear antes de cada carga para poder
# atribuirle el costo. Sin granularidad horaria: UNA corrida por dia.
run_id = "2026-08-31-humo"

# ── T-07 · La perilla ─────────────────────────────────────────────────────
# 0 = infra creada, cero computo, no hace falta que existan las imagenes.
# 1 = servicios corriendo.
desired_count = 0

# ── Consumidores de C4 ────────────────────────────────────────────────────
# Aparte de desired_count, que es el interruptor de T-07 y lo comparten los
# tres servicios. Ver variables.tf: subir desired_count daria tambien dos
# orquestadores, y eso rompe la medicion.
c4_replicas = 2

# Ritmo del consumidor. La concurrencia no cambia lo que se mide; el lote
# transaccional SI: e9→e10 pasa a medir el lote y no el evento.
c4_concurrencia     = 8
c4_lote_transaccion = true

# Tag de las imagenes en ECR. "humo" para las prestadas de la fase 1.
imagen_tag = "humo"

# ── La perilla que mas mueve el costo fijo ────────────────────────────────
# Cada interface endpoint pone UNA ENI POR AZ, a ~$0,01/h cada una.
#   az_count = 2  ->  15 endpoints x 2 = 30 ENIs = ~$7,20/dia
#   az_count = 1  ->  15 endpoints x 1 = 15 ENIs = ~$3,60/dia
#
# Con UN tenant, la segunda AZ no ejercita nada: no hay reparto de carga
# ni tolerancia a fallo que probar. 50client sube a 2, que es lo que pide
# el doc. El codigo es identico — cambia el numero, no la estructura.
az_count = 1

presupuesto_mensual_usd = "50"

# ── El tope del manifiesto de O-08 ────────────────────────────────────────
# Con 39 tenants a ~926 ev/s y `eventos_por_hilo: 1` -cada evento es su propio
# expediente- el default de 200.000 se agota en 216 SEGUNDOS. Pasado el tope el
# manifiesto sale `truncado: true` y la conciliacion se niega a dar ok: la
# corrida entera queda sin responder P4 aunque todos los eventos hayan llegado.
#
# 1.000.000 cubre la corrida de 600 s (~556.000 documentos) con margen, y son
# ~220 MB de heap sobre los 6.144 que declara la task.
orq_manifiesto_tope = 1000000
