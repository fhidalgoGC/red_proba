# 08 — Límites y riesgos

Techos que existen aunque todo esté bien implementado.

## ⛔ Bloqueantes — se piden con días de anticipación

### Cuota de Fargate vCPU

~106 tareas a 1–2 vCPU son unos 150 vCPU. El límite
`Fargate On-Demand vCPU resource count` viene muy por debajo. Sin el aumento,
las tareas se quedan en `PROVISIONING` y **la prueba se cancela**.

### Cuota de operaciones criptográficas de KMS  ⚠ EL CRÍTICO

| | |
|---|---|
| Límite por defecto (ECC) | **1.000 ops/s por región** |
| Objetivo de la prueba | **2.000 ops/s** |
| Pico | **2.300 ops/s** |

Hay **una llamada `Sign` por evento**. Todo el perfil de carga vive por encima
del límite — incluso el valle de 900 no deja margen para reintentos.

**Sin el aumento a 3.000, la prueba mide throttling en vez de arquitectura.**

### Costo de firma — el renglón dominante

A $0,15 por cada 10.000 operaciones asimétricas:

| Ritmo | Por hora |
|---|---|
| 1.200 ev/s | $64,80 |
| 2.000 ev/s | **$108,00** |
| 2.300 ev/s | $124,20 |

Cinco horas de carga a 2.000/s ≈ **$540**. Varias veces el cómputo de las tres
VPC juntas. **Es el único renglón que depende del objetivo de eventos/s.**

Comparación: el cómputo de 100 tareas por 8 h ronda los $64 en us-east-1
(~$86 en sa-east-1).

## Techos de servicio

### SQS FIFO

| Configuración | Límite |
|---|---|
| Sin batching | 300 mensajes/s |
| Con batching de 10 | **3.000 mensajes/s** |
| Alto rendimiento | 300/s **por grupo**; el total escala con el nº de grupos |

A 2.000/s con batching son **200 llamadas/s** — cabes al 67% del límite normal,
y el pico de 2.300 te deja al 77%. Entra, pero sin margen. **Activar alto
rendimiento**: no cuesta nada.

Los 300 son **por acción de API**, independientes: 300 envíos, 300 recepciones y
300 borrados. C4 también necesita ~200 recepciones y ~200 borrados por segundo.

> ⚠ **Cuando falla, no rechaza el mensaje.** Devuelve `ThrottlingException` y el
> SDK reintenta solo con backoff. **No verás errores**: verás la latencia de
> publicación crecer y el outbox llenarse, sin excepción que lo explique. Por
> eso se mide e5→e6 por separado.

Activar alto rendimiento obliga a que el alcance de deduplicación sea por grupo
y el límite de throughput por `MessageGroupId`. En este diseño no molesta: un
duplicado del mismo evento comparte `rpf_id` y `payload_hash`, cae en el mismo grupo
y se detecta igual.

### Mensajes en vuelo

**20.000** en una cola FIFO. Si el consumidor se atrasa, la cola deja de
entregar con `OverLimit` — y el síntoma parece que se vació, cuando en realidad
está llena.

### Tamaño de mensaje

256 KB. Con el sobre de ~4,3 KB hay **60× de margen**. No es un riesgo real en
esta prueba.

## Riesgos de implementación

| Riesgo | Cómo se manifiesta |
|---|---|
| **Security group mal asignado** | Falla en silencio: todo funciona, pero el aislamiento entre tenants no existe. Solo lo detecta una prueba explícita de conexión cruzada. |
| **Resource policy de la cola** | `AccessDenied`, y el mensaje no distingue si falta la policy de la cola o el permiso de KMS. |
| **Postgres efímero** | Una tarea de base que muere se lleva su outbox. En la demo se ve como pérdida de eventos aunque el patrón esté bien implementado. |
| **Sin `finally` en el relay** | Una excepción congela el relay para siempre; el health check sigue en verde. |
| **Sin circuit breaker** | Una caída de SQS de 15 min manda todas las filas a `FAILED` por un problema que no era de ellas. |
| **Dedup por contenido activada** | Con AES-GCM el ciphertext cambia siempre: SQS nunca detectaría un duplicado. |
| **Percentiles promediados** | El número reportado no significa nada. |
| **Lazo cerrado en el orquestador** | La prueba miente: un sistema lento recibe menos carga y se ve sano. |
