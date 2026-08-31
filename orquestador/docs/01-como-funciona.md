# 01 — Cómo funciona

Seguimos un evento desde que llega el `POST` hasta que su latencia aparece en
el informe.

```
1 · al arrancar   pool de 1.000 plantillas          40 ms, una vez
2 · al POST       plan: cuota, instantes, índices    5 ms
3 · 5 s antes     materializar: índice → documento
4 · cada 10 ms    disparo de lo que vence
5 · red           C3 responde cuando puede
6 · siempre       contabilidad y logs
```

Lo caro —construir plantillas y construir cuerpos— ocurre **fuera** del
momento de disparar. El tick solo coge lo que ya está hecho.

---

## 1 · El pool, al arrancar el contenedor

Un documento fiscal cuesta construir 70 atributos hoja, hacer la aritmética en
centavos y canonizar el evento dos veces para ajustar el relleno. A 3.000
eventos por segundo eso convertiría al orquestador en el cuello de botella, y
la prueba mediría al generador en vez de a la arquitectura.

Se paga una vez: **1.000 plantillas en 40 ms**, 2,2 MB en memoria.

Cada plantilla sortea su tamaño en `[2048, 4096]` bytes y sus ítems en `[1, 5]`:

```
1600 B   [ esqueleto 1240 B ][1 ít.][·]
2296 B   [ esqueleto 1240 B ][1 ít.][ relleno base64        ]
3046 B   [ esqueleto 1240 B ][ 5 ítems · 164 B c/u ][ relleno ]
```

**El piso no es negociable.** El esqueleto del documento fiscal —los **70
atributos hoja** de [02-payload](../../docs/02-payload.md)— pesa hasta **1.864
bytes canónicos sin un solo ítem**, y **2.024 con el ítem mínimo**. Un documento
fiscal sin ítems no existe, así que nada por debajo es alcanzable sin mutilarlo,
y un documento mutilado no compara con nada. Mínimo admisible: **2.032**.

**El techo tampoco.** 4.096 es el límite de `kms:Sign` con `MessageType: RAW`,
que es el que exige `ED25519_SHA_512`. A 4.096 la firma entra con margen cero.

El relleno usa alfabeto **base64**: 1 carácter = 1 byte y ninguno necesita
escape en JSON. Con bytes crudos, una comilla se escaparía al serializar y el
tamaño no cuadraría.

El tamaño se mide sobre la forma **canónica** (JCS RFC 8785) y en **bytes**,
nunca en caracteres — un acento son dos bytes.

> `npm run volcar` escribe las 1.000 plantillas a `salida/plantillas/` para
> poder mirarlas. **No es de donde lee el orquestador**: en una corrida viven
> solo en memoria y la reproducibilidad viene de `pool.semilla`, no del disco.

---

## 2 · El plan, al recibir el POST

Antes de que salga un solo evento se decide **toda** la aleatoriedad.

### a · La cuota de cada segundo — en PETICIONES

Un entero, garantizado dentro del rango:

```
N = ⌊min + azar × (max − min + 1)⌋

seg 1   seg 2   seg 3   seg 4   seg 5
 142     188     123     144     192      ← con request.client = {100, 200}
```

⚠ **Son PETICIONES HTTP, no eventos.** Cuántos documentos lleva cada una lo
decide `events.client`, y se sortea por petición (paso *b bis*). Los dos juntos
dan el ritmo de eventos:

```
eventos/s = peticiones/s × documentos por petición
```

Con `eventos_por_request = 1` —el valor por defecto— los dos números coinciden
y la diferencia no se nota. En cuanto una petición lleva varios documentos son
cosas distintas.

**Es una cuota exacta, no una media.** Antes esto sorteaba intervalos
exponenciales con media λ —un proceso de Poisson de verdad— pero el conteo por
segundo de un Poisson es una variable aleatoria con desviación √λ: con un
máximo de 80 salían segundos de 94.

### b · Los N instantes, dentro de ese segundo

N posiciones al azar, ordenadas:

```
|| |    |  |||     |   ||    |  |||    |     ||   |
0 ms                                              990 ms
```

Racimos y huecos — es lo que llena el outbox. Que el conteo esté fijado no los
elimina: por la **propiedad de uniformidad condicional**, un proceso de Poisson
del que se conocen sus N llegadas las tiene distribuidas uniformemente en el
intervalo. Sortear N posiciones y ordenarlas produce exactamente los mismos
racimos.

**Nada se programa en el último tick.** La ventana es de 990 ms y no 1000: un
evento en el milisegundo 999,7 no tendría ningún tick por delante y moriría sin
disparar.

Con `arrivals: "uniforme"` las posiciones van equiespaciadas — tráfico de
laboratorio, para contrastar.

### b bis · Cuántos documentos lleva cada petición

Un sorteo **por petición**, no uno por segundo: dos peticiones del mismo
segundo pueden llevar 3 y 9 documentos.

```
events.client = {1, 10}   →   [ 5, 2, 9, 1, 7, 3, … ]   una por petición
```

Un tamaño de lote fijo es tráfico de laboratorio. En producción los lotes
varían, y el destino tiene que aguantarlo.

Sin `events.client`, el tamaño es fijo y lo pone `envio.eventos_por_request`
— así las configuraciones que ya existían siguen dando exactamente lo mismo.

### c · Qué documento le toca

```
idx = ⌊azar × 1000⌋   →   [ 417, 92, 806, 233, … ]
```

**El plan guarda índices, no cuerpos.** Un índice pesa 4 bytes; un documento,
2 KB. Una corrida de 3,5 h a 2.000 ev/s son 25 millones de eventos: 96 MB como
índices, 54 GB como documentos.

### Los cinco flujos de PRNG

Todo lo determinista sale de mulberry32 sembrado, en cinco flujos separados:

| Flujo | Decide | Cuándo |
|---|---|---|
| `semilla` | ítems, importes, CNPJ, tamaño de cada plantilla | al arrancar |
| `^ 0x85ebca6b` | cuántas **peticiones** lleva cada segundo | al planificar |
| `^ 0x9e3779b9` | los instantes dentro del segundo | al planificar |
| `^ 0x5f3759df` | qué plantilla le toca a cada evento | al planificar |
| `^ 0xc2b2ae35` | cuántos **documentos** lleva cada petición | al planificar |

Separados a propósito: si compartieran uno, cambiar el rango de `events`
desplazaría también la elección de plantillas y dos corridas con la misma
semilla dejarían de ser comparables — que es justo lo que la semilla existe
para garantizar.

Dos cosas quedan fuera del PRNG. El **relleno** usa `randomBytes` porque su
contenido no se firma, solo importa su largo. Y la **identidad** usa
`randomUUID`, que es lo que hace único el `payload_hash`.

---

## 3 · Materializar, cinco segundos antes

Convertir los índices de una petición en sus documentos: coger cada plantilla y
refrescarle la identidad.

```
SE REFRESCAN                      SE REUSA TAL CUAL
  rpf_id       UUID · 36            participant · counterparty
  event_id     UUID · 36            document · totals · items
  occurred_at  ISO  · 24            transport · payment · origin
  party_id     hmac · 69
  sequence     entero · VARIABLE  ← el único que mueve el tamaño
```

`sequence` es el único que cambia de largo. De 9 a 10 el documento crece un
byte, así que se recorta un byte de relleno. Es **O(1)**: no hace falta volver
a canonizar. Cada plantilla reserva 8 bytes para que `sequence` pueda llegar a
nueve dígitos sin quedarse sin de dónde recortar.

> **Por qué se refresca la identidad y no se reenvía la plantilla tal cual.**
> El `MessageDeduplicationId` es el sha256 del payload canónico **en claro**.
> Dos envíos del mismo documento producen el mismo `payload_hash` y SQS FIFO
> descarta el segundo **en silencio** durante su ventana de 5 minutos.
> Perderías la mayor parte de los eventos y P4 daría un falso negativo masivo,
> sin un solo error en los logs.

Comprobado interceptando 29 cuerpos en el cable: **28 plantillas distintas y 29
`event_id` únicos**.

### Las dos ventanas deslizantes

```
   ya pasó        AHORA      +5 s              +60 s
  ─────────┼──────────┼─────────┼───────────────┼───────
  liberado    disparando   cuerpos listos    solo índices
```

| | En memoria |
|---|---|
| plan vivo (60 s de índices) | 469 KB |
| cuerpos vivos (6 s) | 22 MB |

Constante, dure la corrida 20 segundos o tres horas y media.

Los cuerpos se liberan en **dos momentos**: al serializar —el `.then()` no
captura `documentos`, así que los objetos mueren en cuanto `enviar()` retorna;
solo sobrevive la cadena serializada, hasta que llega la respuesta— y al cerrar
el segundo (`s.docs = null`), que cubre lo que nunca llegó a enviarse.

Se materializa **un solo segundo por tick**. Construir los cinco de golpe haría
que ese tick tardara cinco veces más y pudiera llegar tarde a disparar.

---

## 4 · El disparo, cada 10 ms

Un **único** `setInterval` para toda la corrida:

```ts
this.timer = setInterval(() => this.tick(), perfil.llegadas.tickMs);   // 10 ms
```

El cambio de segundo se detecta leyendo el reloj, no con un temporizador por
segundo:

```ts
const segAbs = Math.floor(ahora / 1000);
if (segAbs !== this.segundoRitmo) {
  this.cerrarSegundo();          // cierro la caja anterior
  this.segundoRitmo = segAbs;    // activo la nueva
}

while (e.disparado < s.eventos.length && s.eventos[e.disparado]!.ms <= ahora) { … }
```

`e.disparado` es un **cursor**, no un recorrido: el tick mira solo el siguiente
evento y, si aún no le toca, sale. **Coste medido: 0,23 µs por tick con 50
tenants** — un 0,23% de un núcleo.

### Por qué no un timer por segundo, ni uno por evento

`setInterval(fn, 1000)` **acumula deriva**: no se autocorrige, y en corridas de
horas se desalinea del reloj real. Leyendo `Date.now()` en cada tick la deriva
es cero: si un tick llega tarde por una pausa de GC, el siguiente se recoloca.

Un `setTimeout` por evento sería lo más literal, pero a 3.000 ev/s son 3.000
temporizadores por segundo entrando y saliendo del heap, y `setTimeout` tiene
su propia imprecisión de ~1 ms.

Con ticks de 10 ms, un evento programado en el ms 347 sale en el del 350: hasta
10 ms tarde, siempre dentro de su segundo. Para medir un sistema cuya latencia
son cientos de milisegundos, es ruido.

### Un segundo es una caja cerrada

Lo que no salga antes de que cambie el segundo **no se arrastra**: se cuenta
como `dropped_lag` y se descarta. Arrastrarlo permitiría que un segundo
superara su cuota máxima con deuda del anterior, y el rango dejaría de
significar nada.

### Sin buffer: el tamaño lo decide el plan

Cada petición sale entera en su instante, con los documentos que el plan le
asignó. **No hay buffer que se llene.**

Antes los eventos se acumulaban hasta juntar `eventos_por_request` y se
soltaban. El problema no era el rendimiento: era que **el instante de salida
dependía del ritmo de llegada**. Un tenant de la cola larga de Zipf tardaba
segundos en juntar su lote, y esa espera se medía como latencia del sistema
cuando era latencia del arnés. Existía `espera_maxima_lote_ms` justamente para
taparlo — y con el tamaño en el plan deja de hacer falta.

```ts
enviar(tenant, documentos, bytes): boolean    // ← booleano, NO una promesa
```

**Nunca se hace `await` de un envío.** Si el planificador esperara la respuesta
para mandar lo siguiente, un destino lento recibiría menos carga y parecería
sano porque nadie lo está presionando. Ver [05-reglas](05-reglas.md).

---

## 5 · El emisor

Un pool de undici por destino, con keep-alive y timeout explícito.

```ts
new Pool(t.url, {
  connections: conexionesPorDestino,
  pipelining: 1,        // sin pipelining: encolar en la misma conexión añade
  keepAliveTimeout: 30_000,   // una cola invisible que ensucia la latencia
  headersTimeout: timeoutMs,
  bodyTimeout: timeoutMs,
})
```

Cabeceras de cada petición:

```
content-type: application/json
x-lote-id:    <uuid>
x-tenant-id:  tenant-01
x-eventos:    20
x-prueba-id:  xx01        ← agrupa los logs de C3 por corrida
```

> **`connections` es un techo duro de ritmo.** Por la ley de Little, el máximo
> que un pool puede sostener es `conexiones / latencia` req/s. Con 32
> conexiones contra un destino de 0,8 s son **40 req/s**, pidieras lo que
> pidieras. Por eso `connections` sigue a `concurrency` por defecto: dos topes
> distintos para lo mismo solo sirven para que uno cape al otro en silencio.

El cuerpo drena siempre, aunque no se mire:

```ts
await res.body.dump();
```

Dejarlo sin consumir retiene la conexión del pool y a los pocos miles de
peticiones el emisor se queda sin conexiones y falsea la saturación.

---

## 6 · La contabilidad

Dos instantes, no uno:

```ts
const t0 = performance.now();
this.metricas.enviados(tenant.id, n, bytes);        // ← SENT, al llamar

pool.request({ … })
  .then(async (res) => {
    await res.body.dump();
    this.metricas.completados(…, performance.now() - t0, res.statusCode);  // ← COMPLETED
  })
  .catch(() => this.metricas.fallidos(…));          // ← FAILED, sin muestra de latencia
```

- **`sent`** se anota al llamar al endpoint. No espera nada.
- **`completed`** se anota cuando la respuesta vuelve, **con el código que
  sea** — 200, 429, 503. El desglose va en `ok` / `not_ok`.
- **`failed`** es timeout o error de red: no hubo respuesta, y **no cuenta como
  completado**. Confundirlos borraría la diferencia entre «el destino me dijo
  que no» y «el destino no dijo nada».

Cada anotación cae en la casilla del segundo **en que ocurre**. Por eso `sent`
y `completed` casi nunca cuadran dentro de un segundo, y siempre cuadran en el
total: lo que se envió en el segundo 5 puede completarse en el 7.

La **latencia** mide el viaje completo, desde `pool.request()` hasta la
respuesta, y se anota con los completados. `latency_samples` es exactamente
`completed.count` — un timeout no aporta muestra. Eso importa al leer: si el
destino se ahoga y la mitad revienta por timeout, el p50 describe solo a los
supervivientes, que son los rápidos. **La latencia puede parecer buena justo
cuando el sistema está peor.** Léela siempre junto a `failed`.

Las muestras se comprimen a un resumen de seis campos en cuanto el segundo pasa
y el array se libera: retenerlas sería inviable —50 tenants × 4 h × cientos de
muestras por segundo— y el resumen da percentiles exactos del segundo. Tope de
**250 muestras por segundo y tenant**.

---

## El cierre

El informe se cierra cuando **no queda nada en vuelo**, no cuando se acaba el
reloj. Por eso dura más que los `seconds` que pediste: los últimos segundos
tienen `sent: 0` y solo entran respuestas.

Hay un techo de `timeout + 2 s` por si alguna respuesta no vuelve nunca. Si
vence, el informe lo dice —`cerrado_por: "fin del batch (quedaron respuestas
sin volver)"`— en vez de presentarse como completo.
