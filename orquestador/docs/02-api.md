# 02 — La API

**Swagger con «Try it out» y ejemplos precargados: `http://localhost:3000/docs`**
El OpenAPI en crudo, para importar a Postman: `http://localhost:3000/docs-json`

| Método | Ruta | Qué hace |
|---|---|---|
| `POST` | `/batch` | Lanza un batch. Devuelve **202 al momento** |
| `GET` | `/batch/{id}` | Progreso en vivo, o el informe completo |
| `GET` | `/batch` | Los batches que hay en `logs/` |
| `POST` | `/batch/detener` | Corta el envío; el informe se cierra solo |
| `GET` | `/status` | Ofrecido vs enviado vs completado, en vivo |
| `GET` | `/status/tenants` | Desglose por tenant |
| `GET` | `/status/serie?segundos=120` | La serie segundo a segundo |
| `GET` | `/status/plan` | El reparto tal como lo calculó el planificador |
| `GET` | `/health` | Salud del contenedor |

---

## `POST /batch`

```bash
curl -X POST localhost:3000/batch -H 'content-type: application/json' -d '{
  "id": "xx01",
  "client": "all",
  "seconds": 20,
  "request": { "client": { "min": 20, "max": 80 } }
}'
```

```jsonc
202 Accepted
{
  "prueba": "xx01",
  "estado": "procesando",
  "destinos": ["tenant-01", "tenant-02"],
  "duracion_prevista_s": 20,
  "peticiones": { "porCliente": { "min": 20, "max": 80 } },
  "consulta": "GET /batch/xx01",
  "en_vivo": "GET /status"
}
```

### El POST no espera. Nunca.

Devuelve en cuanto la corrida arranca — **1,8 ms medidos**. Una petición HTTP
que se queda abierta cinco minutos es frágil por todos lados: la corta un
balanceador, la corta un proxy, la corta el propio cliente, y cuando eso pasa
la corrida sigue viva pero te has quedado sin su informe.

Lanzar y consultar por separado también es lo único que funciona contra un
contenedor en Fargate detrás de un ALB, que es donde esto va a vivir.

---

## El payload

Todos los campos son opcionales.

### Qué y a quién

| Campo | Por defecto | Qué hace |
|---|---|---|
| `id` | `corrida-<fecha>` | Nombra los logs de **los dos lados**. Un id ya usado se rechaza con 409 |
| `client` | todos | `"all"`, el id (`"tenant-02"`), o el índice **empezando en 1** (acepta `1` y `"1"`) |
| `seconds` | 20 | Cuánto tiempo se **envía**. El informe dura más |

### Cuánto — tres formas excluyentes

| Campo | Por defecto | Qué hace |
|---|---|---|
| `request.client` | — | `{min, max}` eventos **por cliente y por segundo**. Cada segundo se sortea un entero dentro del rango y ese es el número exacto que sale |
| `rate` | 40 | Ritmo **plano** en ev/s por tenant |
| `events` | — | **Total** de eventos, repartido en la ventana con un número aleatorio de llamadas por tenant |

`request.client` acepta también `[min, max]` y un escalar (`40` = rango
degenerado).

```jsonc
// aleatorio entre 20 y 80 cada segundo
{ "request": { "client": { "min": 20, "max": 80 } } }

// plano
{ "rate": 40 }

// 2.500 eventos en total
{ "events": 2500, "seconds": 60 }
```

Pedir dos a la vez da **400**:

```
'rate' y 'request' son excluyentes: 'rate' fija un ritmo plano,
'request' fija rangos de ritmo, 'events' fija un total.
```

### Cómo se envía

| Campo | Por defecto | Qué hace |
|---|---|---|
| `perRequest` | del YAML (1) | Eventos por petición HTTP. Con 1, 20 eventos = 20 peticiones concurrentes |
| `connections` | = `concurrency`, o 2048 | Conexiones simultáneas por destino. **Techo duro de ritmo** |
| `concurrency` | **0 = sin tope** | Tope de peticiones en vuelo. Ponerlo es un lazo cerrado — ver [05-reglas](05-reglas.md) |
| `timeout` | del YAML (5000) | Timeout HTTP en ms |
| `arrivals` | `poisson` | `poisson` (racimos) o `uniforme` (equiespaciado) dentro del segundo |
| `spread` | `zipf` | Reparto entre tenants, solo si no hay `request.client` |
| `thread` | del YAML (1) | Eventos que comparten `rpf_id`, es decir `MessageGroupId`. **La perilla de D-06** |

### El payload

| Campo | Por defecto | Qué hace |
|---|---|---|
| `seed` | del YAML | Semilla del PRNG. Misma semilla, mismas plantillas |
| `size` | `[1536, 3072]` | Rango del tamaño canónico en bytes. Piso duro: 1.411 |
| `items` | `[1, 5]` | Ítems por documento |
| `pool` | 1000 | Plantillas pre-generadas |
| `verify` | 0.01 | Fracción a la que se comprueba el tamaño canónico |

Los cuatro últimos **reconstruyen el pool** (~40 ms). Solo si cambian de
verdad: reconstruirlo sin motivo cambiaría el relleno entre corridas que
deberían salir idénticas.

---

## `GET /batch/{id}`

### Mientras corre

```jsonc
{
  "prueba": "xx01",
  "estado": "procesando",
  "fase": "enviando",              // o "cerrando el informe"
  "transcurrido_s": 6,
  "en_vuelo": 58,
  "progreso": {
    "offered": 789,
    "sent":      { "count": 789, "dropped_lag": 0, "dropped_saturation": 0 },
    "completed": { "count": 612, "ok": 612, "not_ok": 0, "failed": 0 }
  },
  "ultimo_minuto": { … },
  "ritmos_vigentes": [ { "tenant": "tenant-01", "ev_s": 116, "disparados": 26, "materializados": 6 } ],
  "detalle": "Vuelve a consultar en unos segundos; el informe completo aparece al cerrar."
}
```

### Al terminar

El informe completo del log. Ver [03-informe](03-informe.md).

```jsonc
{ "estado": "terminado", "prueba": "xx01", "resumen": { … }, "tenants": { … } }
```

---

## Los errores

Todos llevan el motivo concreto, no un mensaje genérico.

```jsonc
400  { "error": "client '99' no existe. Hay 2: 1=tenant-01, 2=tenant-02. Tambien vale \"all\"." }
400  { "error": "client debe ser texto o numero, vino boolean (true)." }
400  { "error": "request.client: max (20) es menor que min (80)" }
400  { "error": "rate y request son excluyentes: …" }
400  { "error": "pool.tamano_bytes[0] = 900, pero el documento fiscal no baja de 1433 bytes…" }

409  { "error": "el batch 'xx01' ya esta corriendo",
       "estado": "enviando", "consulta": "GET /batch/xx01" }
409  { "error": "el batch 'xx01' ya termino",
       "detalle": "Su informe ya existe y no se sobrescribe. Usa otro id, o consultalo." }

404  { "error": "no hay ningun batch con id 'nohay'",
       "detalle": "GET /batch lista los que existen." }
```

Ese segundo **409 evita pérdida de datos**: repetir un id sobrescribiría el
informe anterior en silencio.

El `409` mira la **corrida**, no solo el planificador: entre que el reloj para
y el informe cierra pasan unos segundos en los que el batch sigue vivo.

---

## Ejemplos listos

```bash
# aleatorio dentro de un rango, a los dos tenants
curl -X POST localhost:3000/batch -H 'content-type: application/json' -d '{
  "id":"r1","client":"all","seconds":20,
  "request":{"client":{"min":20,"max":80}}}'

# un solo cliente, ritmo plano
curl -X POST localhost:3000/batch -H 'content-type: application/json' -d '{
  "id":"r2","client":1,"seconds":20,"rate":40}'

# el objetivo de la PoC, con conexiones suficientes
curl -X POST localhost:3000/batch -H 'content-type: application/json' -d '{
  "id":"objetivo","client":"all","seconds":300,
  "request":{"client":{"min":40,"max":60}},
  "connections":2048}'

# forzar el techo de 300 msg/s por MessageGroupId (D-06)
curl -X POST localhost:3000/batch -H 'content-type: application/json' -d '{
  "id":"d06","client":1,"seconds":30,"rate":400,"thread":50}'

# consultar y parar
curl localhost:3000/batch/r1
curl -X POST localhost:3000/batch/detener
```

## Para Postman

No lo copies: **impórtalo**.

> Import → pestaña **Link** → `http://localhost:3000/docs-json`

Crea la colección entera con las nueve rutas, descripciones y ejemplos. Usa una
variable `{{orq}}` para la base: cuando esto pase a AWS solo cambias la
variable.
