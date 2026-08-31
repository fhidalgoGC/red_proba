# 07 · Medición

Siete marcas, `e0..e6`, en **columnas de la fila del outbox**.

> **Nunca dentro del payload** (regla 8). El payload va firmado; meterle
> metadatos de medición cambiaría lo que se firma.

---

## Las siete marcas

| | Qué instante es |
|---|---|
| `e0_listo` | C3 recibió el documento y lo entrega al mapper |
| `e1_canonizado` | JCS terminó |
| `e2_firmado` | `KMS Sign` devolvió |
| `e3_cifrado` | el sobre está sellado |
| `e4_commit` | la transacción de negocio escribió |
| `e5_reclamado` | el relay tomó la fila |
| `e6_publicado` | SQS confirmó |

**Las siete salen del reloj de este proceso.** Ver el bug de relojes en
[04 · El outbox](04-outbox.md).

---

## Los tramos, medidos

803 eventos reales del orquestador, con KMS, SQS y Postgres de verdad:

| tramo | ms | |
|---|---|---|
| `e0→e1` mapper | 0,1 | validar + canonizar es gratis |
| `e1→e2` **firma KMS** | **83,0** | el cuello de botella de C3 |
| `e2→e3` cifrado | 4,4 | AES en proceso |
| `e3→e4` commit | 3,3 | |
| `e4→e5` espera en outbox | 96,1 | ⚠ saturación |
| `e5→e6` publicar a SQS | 81,6 | |
| **`e0→e6` C3 completo** | **~270** | |

Y de punta a punta, cruzando a C4:

| tramo | ms |
|---|---|
| `e6→e7` **tiempo en cola** | **500,3** |
| `e7→e10` C4 completo | 28,4 |
| **`e0→e10` extremo a extremo** | **800,3** |

---

## El hallazgo

Con solo `e0..e4` medido, **la firma parecía el 92% del problema**.

Con la cadena entera, el tiempo en cola es el **62% del total** — 500 de 800 ms.
La firma sigue siendo el cuello de **C3**, pero la cola es el cuello del
**sistema**.

Es exactamente la clase de respuesta que P3 pedía, y solo aparece midiendo el
camino completo. En una corrida con dos tenants a ~65 ev/s:

```
C3 publica    65,3 ev/s
C4 consume    48,0 ev/s      ← no da abasto
```

Y no por trabajo propio: descifrar 1,0 ms + verificar 0,4 + persistir 4,3 son
**5,7 ms por evento**, que darían ~175 ev/s. Lo que lo frena es consumir de a un
mensaje por ciclo.

---

## El log de tiempos · `c3/logs/<prueba>__<tenant>.json`

Las marcas `e0..e6` viven en la base y **sobreviven al proceso**: son lo que
permite conciliar contra el inbox de C4. Pero son ISO 8601 —resolución de
milisegundo— y en local canonizar tarda 0,05 ms: los tramos cortos salen en 0 y
el informe diría que el pipeline es gratis.

Así que hay un segundo registro, en paralelo y con otra unidad: **duraciones**,
tomadas con `process.hrtime.bigint()` (monótono, nanosegundos) y agregadas
**segundo a segundo por prueba**. Mismo formato que el informe del orquestador,
para poder ponerlos uno al lado del otro.

```jsonc
{
  "prueba": "abc16", "tenant": "tenant-01",
  "inicio": "…", "fin": "…", "duracion_s": 6.4,
  "cerrado_por": "silencio",              // "en curso" | "silencio" | "apagado"
  "total":   { /* … igual que un segundo, con percentiles aproximados */ },
  "seconds": [ { "seg": 1, "at": "…", "metrics": {
      "request": { "init": 4, "completed": 4, "failed": 0,
                   "latency_p50_ms": 15.7, "latency_p99_ms": 17.9,
                   "latency_max_ms": 17.9, "latency_avg_ms": 15.7, "samples": 4 },
      "events":  { "init": 12, "completed": 12, "discarded": 0,
                   "bytes": 36837, "weight": "36.0 KB", "per_request": 3,
                   "event_ids_unicos": 12, "event_ids_duplicados": 0,
                   "steps": {
                     "canonical": { "init": 12, "completed": 12, "n": 12, "muestras": 12,
                                    "p50_ms": 0.063, "p95_ms": 0.504, "p99_ms": 0.504,
                                    "max_ms": 0.504, "avg_ms": 0.107, "suma_ms": 1.284 },
                     "sign": {…}, "encrypt": {…}, "outbox": {…}, "pipeline": {…},
                     "delay": {…}, "wait": {…}, "sqs": {…} } },
      "sqs":     { "batches": 0, "messages": 0, "ok": 0, "retry": 0, "failed": 0 }
  } } ],
  "minutes": [ … ]                        // solo con más de 60 segundos
}
```

### `init` no es `completed`

| | |
|---|---|
| `init` | llegó la petición. Se cuenta **al llegar** |
| `completed` | C3 contestó 202. Se cuenta **al responder** |
| `failed` | reventó: no hubo 202. **No** es `completed` |

No caen en el mismo segundo, y ese desfase **es** la latencia. Cuando el
pipeline se atasca, `init` mantiene su ritmo y `completed` se hunde. Es el mismo
par que `sent`/`completed` del orquestador, visto desde el otro lado del cable.

La latencia de un `failed` no entra en los percentiles: el tiempo hasta un fallo
no es tiempo de servicio — un fallo rápido bajaría el p99 y un timeout lo
dispararía, las dos veces sin que el rendimiento haya cambiado.

**El mismo par baja a cada paso.** `canonical.init` / `canonical.completed`, y
así los ocho. `init` se anota en el segundo en que el tramo **empezó** y
`completed` en el que **terminó** — dos momentos distintos y a menudo dos
segundos distintos. Que en una fila coincidan no es lo normal: significa que en
ese segundo no quedó nada a medio hacer.

Así se lee un arranque real, con KMS como cuello:

```
seg 1  request 45/0    canonical 45/45   sign 45/0    pipeline 45/0
seg 2  request 34/0    canonical 34/34   sign 34/61   encrypt 61/0   pipeline 34/0
seg 3  request 75/11   canonical 210/210 sign 210/86  encrypt 85/146 pipeline 75/11
```

Entran 45 firmas y no vuelve ninguna. En el segundo 2 empiezan 34 más y salen
61 — las 45 atascadas más 16 de las nuevas. `canonical` cierra siempre en su
mismo segundo porque es síncrono y tarda 0,08 ms; `sign` no, porque es una
llamada a KMS. **Eso** es lo que responde P3, y un solo contador no lo enseña.

`init - completed` son las ejecuciones que entraron y no salieron. Tres motivos:

| | |
|---|---|
| siguen **en vuelo** | cerrarán en un segundo posterior. Es el caso normal |
| el documento se **descartó** ahí | `events.discarded` lo cuenta. Solo en `canonical`, y no es un fallo de C3 |
| el tramo **reventó** | no hubo 202; `request.failed` lo cuenta |

En el `total` de la corrida los que estaban en vuelo ya cerraron: si ahí
`sign.init` sigue por encima de `sign.completed`, se perdió trabajo de verdad.

### La aritmética cuadra en el `total`, no en una fila

```
total:  canonical.suma_ms + sign.suma_ms + encrypt.suma_ms + outbox.suma_ms
          = pipeline.suma_ms
total:  pipeline.suma_ms + delay.suma_ms  ≈  latencia total
```

En una fila suelta **no tiene por qué**: los tramos de una petición que cruza la
frontera del segundo caen repartidos entre dos filas — que es exactamente lo que
`init` vs `completed` está enseñando. En el total cada ejecución se cuenta una
vez y la igualdad se cumple. Medido sobre tráfico real (1.051 peticiones, 5.766
documentos) el residuo es del **0,0002%**, unos 11 µs por documento: los
`toISOString()` de las marcas y el `JSON.stringify` del sobre para pesarlo,
trabajo del loop que ningún tramo cubre.

`wait` y `sqs` quedan fuera de esa suma: los mide el relay en su propio timer,
después del 202, y no pertenecen a ninguna petición.

### Cómo se toma el tiempo de cada paso

Dos llamadas por tramo, y **el reloj decide el segundo**, no el código:

```ts
this.metricas.abre(prueba, 'sign');            // init  → segundo de AHORA
const { firma } = await this.firmador.firmar(canonico);
this.metricas.cierra(prueba, 'sign', msDesde(t1, t2));   // completed + muestra
```

`abre()` se llama **antes** de hacer el trabajo y `cierra()` **después**. Cada
una cae en el segundo en que se ejecuta, así que un tramo que cruza la frontera
suma `init` en un segundo y `completed` en el siguiente. Anotar `init` al volver
lo movería al segundo en que acabó — que es justo lo que ya cuenta `completed`.

**La duración se mide aparte, con reloj monótono**, no restando marcas ISO:

```ts
const ahora   = () => process.hrtime.bigint();          // nanosegundos, monótono
const msDesde = (d, h = ahora()) => +(Number(h - d) / 1e6).toFixed(3);
```

Las marcas `e0..e6` tienen resolución de **milisegundo** y van a columnas de la
base. Canonizar tarda 0,08 ms: restando marcas saldría `0` y el informe diría
que el pipeline es gratis. `hrtime.bigint()` es monótono —no lo mueve un ajuste
de NTP a mitad de corrida— y tiene resolución de nanosegundo.

#### Dónde está cada llamada

| paso | `abre` | `cierra` |
|---|---|---|
| `canonical` | `pipeline.service.ts:129` | `:150` |
| `sign` | `:152` | `:158` |
| `encrypt` | `:160` | `:166` |
| `outbox` | `:187` | `:195` |
| `pipeline` | `:119` | `:209` |
| `delay` | `eventos.controller.ts:175` | `:177` |
| `wait` | `relay.service.ts:196` — `paso()`, los dos a la vez | |
| `sqs` | `relay.service.ts:208` — vía `publicacion()` | |

`wait` y `sqs` usan `paso()`, que abre y cierra de golpe: el relay los **observa
ya terminados** en su propio timer, cuando el 202 ya se contestó. Ahí no hay un
«empezó» que este proceso pueda situar en otro segundo.

Y si un tramo abre y **no cierra** —KMS revienta, el documento se descarta— el
`init` queda sin su `completed`. Nadie limpia nada: esa asimetría *es* el dato.

#### De la muestra al percentil

Cada `cierra()` empuja un número a la `Serie` del par `(prueba, segundo, paso)`.
La `Serie` lleva dos cosas a la vez, y no son la misma:

```ts
push(ms) {
  this.n += 1;                  // exacto, siempre
  this.suma += ms;              // exacto, siempre
  if (ms > this.max) this.max = ms;
  if (this.crudas.length < 500) this.crudas.push(ms);   // solo percentiles
}
```

`n`, `suma` y `max` se acumulan en O(1) por muestra y **el techo no les afecta**.
El array `crudas` sí tiene techo, y es el único que alimenta los percentiles —
por eso `muestras` puede quedar por debajo de `n`.

Cuando el reloj pasa de segundo, ese segundo se cierra para siempre: se ordena
`crudas`, se sacan p50/p95/p99 **exactos**, y el array se libera. Retenerlo sería
inviable — una corrida de 4 h a 40 ev/s son ~600.000 números por paso, y hay
ocho.

### Los ocho tramos, y su unidad

| paso | tramo | una muestra por |
|---|---|---|
| `canonical` | `e0→e1` | documento |
| `sign` | `e1→e2` | documento |
| `encrypt` | `e2→e3` | documento |
| `outbox` | `e3→e4` | **petición** — es UNA transacción |
| `pipeline` | `e0→e4` | **petición** — el loop entero |
| `delay` | `e4→r` | **petición** — el retardo artificial de `C3_DELAY_MS` |
| `wait` | `e4→e5` | fila, **solo en el primer intento** |
| `sqs` | `e5→e6` | **llamada** a `SendMessageBatch`, hasta 10 sobres |

Cuatro cosas que no son obvias y cambian cómo se leen los números:

- **`pipeline` no es la latencia de la petición.** A `request.latency` le sobra
  el trabajo del handler y la respuesta — unos 19 ms sobre 1.051 peticiones. El
  retardo artificial ya **no** está en esa diferencia: sale como `delay`, tramo
  propio, para que una perilla de prueba de 300 ms no se lea como coste del
  sistema.
- **`n` no es `muestras`.** `n` son las ejecuciones medidas; `muestras`, las que
  hay detrás de los percentiles. Se separan al llegar al techo de 500 por
  segundo.
- **`wait` solo cuenta el primer intento.** En un reintento, `e5` se reescribe y
  la resta contra `e4` incluye el backoff — una espera *querida*. Una fila que
  falló tres veces mostraría 30 s de «espera en el outbox» y parecería un relay
  atascado cuando el problema es la cola. Eso ya se ve en `sqs.retry`.
- **`sqs.batches` va al lado de `sqs.messages`.** Un p50 de 300 ms por llamada
  con 10 sobres no es lo mismo que 300 ms por sobre; sin los dos números el
  tramo no es comparable con los que sí son por documento.

Un paso **sin muestras no aparece**. Rellenar de `null` haría ilegible el
detalle por segundo, y la ausencia informa: sin `sqs` en un segundo, el relay no
publicó en ese segundo.

### Exactos y aproximados

Dentro de un segundo los percentiles son **exactos**, y no por suerte: una
muestra se anota siempre en el segundo en curso, así que cuando el reloj avanza
a ese segundo ya no le puede llegar nada. Se comprime **una vez**, sobre sus
muestras crudas, y su p50/p95/p99 son los de verdad.

En `minutes` y en `total` se agregan ponderando por muestras y llevan
`"aproximado": true` — un percentil de percentiles no es el percentil real.

**`suma_ms`, `avg_ms` y `max_ms` son exactos en todos los niveles**, incluso
cuando el techo recorta muestras: se acumulan al entrar cada muestra, en O(1), y
el techo solo afecta al array que alimenta los percentiles. Sin eso, un segundo
con 553 ejecuciones y 500 muestras declararía el tiempo de 500 y la suma de los
tramos dejaría de dar `pipeline` sin un solo error a la vista.

`muestras` por debajo de `n` es la señal de que se alcanzó el techo. Los dos
números están en el JSON justamente para poder verlo.

Dos invariantes sostienen la exactitud, y su ausencia costó una corrida entera:

- **Leer no comprime.** Un `GET /status` sobre el segundo en curso no lo cierra.
- **Comprimir acumula, no pisa.** La versión anterior hacía
  `resumen = comprimir(crudas)` y tiraba lo ya comprimido: un segundo vivo que
  se comprimía en un volcado periódico y luego recibía más muestras perdía el
  primer lote. Se veía como `completed: 30` con `n: 25` — cinco peticiones cuyo
  tiempo desapareció del informe sin un solo error. Si alguna vez vuelve a
  fundirse algo, sale `aproximado: true` en vez de pasar por exacto.

### Cuándo se escribe

Cada 10 s mientras llega tráfico (60 s cuando la serie pasa de 600 segundos: el
archivo ya pesa megas y reescribirlo compite con el pipeline que se está
midiendo), más un volcado final tras 8 s de silencio o al recibir SIGTERM.
Escritura atómica —temporal + `rename`—, así que un fallo a media escritura no
puede dejar un JSON truncado.

C3 **no sabe cuándo acaba la corrida**; eso lo sabe el orquestador. De ahí el
volcado periódico: sin él, un contenedor que muere a mitad de prueba se llevaría
el log entero.

`GET /status` da lo mismo **en vivo**, reconstruido desde memoria en cada
llamada: el archivo puede ir hasta un minuto por detrás, `/status` no.

> La columna `prueba` del outbox existe por esto. El relay corre en su propio
> timer, fuera de cualquier request: sin ella no sabría a qué corrida pertenece
> lo que publica, y `wait` y `sqs` caerían en `sin-id` mientras el resto del
> informe lleva el id de verdad. Es metadato de medición, igual que las marcas,
> y por la misma razón vive en una columna y no en el payload.

---

## La conciliación · P4

> **C3 y C4 no comparten base.** No se puede escribir
> `JOIN c3.outbox … c4.inbox`: cruzaría dos dominios sin ruta entre ellos, y
> daría verde por una razón que no existe fuera del portátil.

Se exporta de cada base **por separado** y se cruza fuera — que es lo único que
se podrá hacer en AWS:

```bash
psql -d rpf_c3_tenant01 -tAc "SELECT payload_hash FROM c3.outbox WHERE status='SENT'" > t01.txt
psql -d rpf_c3_tenant02 -tAc "SELECT payload_hash FROM c3.outbox WHERE status='SENT'" > t02.txt
psql -d rpf_c4          -tAc "SELECT payload_hash FROM c4.inbox"                      > c4.txt
# se comparan como conjuntos
```

Resultado de la última corrida:

```
C3  2.089 + 2.180 = 4.269      C4  4.269
perdidos 0  ·  fantasmas 0     ✔ cuadra
```

El `payload_hash` es la llave que une los dos lados, y es la misma en los dos
porque **C4 la recalcula** en vez de creérsela.

---

## La definición operativa del límite

> El sistema está saturado cuando **la profundidad del outbox deja de volver a
> cero** entre ráfagas.

No es la latencia ni la CPU: es que `outbox.pendientes` ya no se vacía. Se lee
en vivo con `GET /health`.
