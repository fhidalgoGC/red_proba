# 04 · Medición

C4 es el último tramo: `e7` a `e10`. Ver
[07-medicion](../../docs/07-medicion.md) para el recorrido completo.

| Marca | Qué es | Dónde vive |
|---|---|---|
| `e6` | SQS confirma (lo pone C3) | outbox de C3 |
| `e7` | **llegó el lote** a C4 | `inbox.e7_recibido` |
| `e7b` | **le toca a este mensaje** | `inbox.e7b_tomado` |
| `e8` | descifrado | `inbox.e8_descifrado` |
| `e9` | firma verificada | `inbox.e9_verificado` |
| `e10` | **COMMIT** en Postgres | `inbox.e10_persistido` |

Las marcas nunca van dentro del payload (regla 8): el payload va firmado y
meterle metadatos de medición cambiaría lo que se firma. Van en columnas de la
fila del inbox.

---

## `e7b`, la marca que no está en el diseño

`07-medicion` define `e7` como «C4 recibe el mensaje». Pero un `ReceiveMessage`
devuelve **hasta 10 mensajes en la misma respuesta**: llegan todos en el mismo
instante y se procesan en serie.

Sin `e7b`, el tramo `e7→e8` del último mensaje del lote **incluye el
procesamiento de los nueve anteriores**.

Medido en la corrida de prueba (12 eventos legítimos, lote de 10):

```
e7 → e10 medio     402 ms
  espera en lote   358 ms   ← esto NO es descifrado
  descifrado        18 ms
  verificación      18 ms
  persistencia       7 ms
e7 → e10 máximo    508 ms
```

**Sin separarlo, el informe habría dicho «descifrar tarda 400 ms»**, y P3
—«¿qué componente se satura primero?»— habría señalado al descifrado, que es
justamente el que menos tarda. La espera no es un artefacto de medición: es
latencia real y pertenece al extremo a extremo. Lo que no puede es atribuirse
al criptográfico.

Así que:

- `e7 → e7b` — **cola interna de C4**. Sube con el tamaño del lote y con lo que
  tarde cada mensaje. Es una señal de saturación, no de trabajo.
- `e7b → e8` — descifrado de verdad.

---

## Los números medidos, con su letra pequeña

De la corrida de punta a punta (`npm run e2e`), 12 eventos legítimos y 6
venenos contra la cola y las llaves reales:

| | |
|---|---|
| Firmar + cifrar (lado productor) | 1.111 ms / 12 = **93 ms por evento** |
| Llamadas a KMS al producir | 12 `Sign`, **1** `GenerateDataKey` |
| Bytes canónicos | 1.763 – 3.060 |
| Bytes del sobre en la cola | 2.960 – 4.692 |
| Llamadas a KMS al consumir | **1** `Decrypt` (16 aciertos de caché), 1 `GetPublicKey` |
| Tiempo en cola aprox. (`e6→e7`) | 523 ms |

**La letra pequeña de los 18 ms.** Son medias sobre 12 eventos que cargan con
la primera llamada del proceso: un `Decrypt` de KMS repartido entre todos, y un
`GetPublicKey` repartido entre todos. En régimen, verificar Ed25519 en local es
**sub-milisegundo**; los 18 ms de «verificación» son en su mayor parte los ~200
ms de bajar la clave pública una única vez, divididos entre 12.

Con corridas largas ese sesgo desaparece solo. Con corridas cortas hay que
decirlo, o el número miente.

**`e6→e7` es aproximado y no debe usarse como resultado final.** `SentTimestamp`
lo pone SQS al aceptar el mensaje, no C3 al publicar, y son relojes distintos
en dominios distintos. Sirve para ver saturación de la cola; no para el número
de P1.

---

## `e10` se estampa después del COMMIT

No cuando el `INSERT` retorna. Si se estampara antes, el tramo `e9→e10` se
perdería justo la parte que se vuelve lenta bajo carga: el fsync del commit.

En el código son dos pasos: la transacción devuelve, se toma `new Date()`, y el
`UPDATE` de `e10` se acumula para todo el lote y se escribe en **una sola
sentencia**:

```sql
UPDATE inbox AS i
   SET e10_persistido = v.e10
  FROM (SELECT unnest($1::text[]) AS payload_hash,
               unnest($2::timestamptz[]) AS e10) AS v
 WHERE i.payload_hash = v.payload_hash;
```

Agrupar no mueve ningún número —el reloj ya paró para cada evento cuando se
tomó *su* `e10`— pero evita un viaje de red por evento en el componente que la
PoC quiere ver saturarse.

Si ese `UPDATE` falla, no es fatal: la fila está, el asiento está, y lo único
que falta es la marca. Deja un agujero en P1, no en P4, y se avisa como
`warn`.

---

## Los tramos, y qué significa que suba cada uno

| Tramo | Si sube, el sospechoso es |
|---|---|
| `e6 → e7` | La cola: C4 no da abasto y se está acumulando |
| `e7 → e7b` | **C4 por dentro**: el lote se procesa en serie y algo tarda |
| `e7b → e8` | KMS `Decrypt` — o que el caché de data key no está acertando |
| `e8 → e9` | Nada de red: es CPU. Solo sube con payloads mucho más grandes |
| `e9 → e10` | Postgres: fsync, pool agotado, o las proyecciones |

> ⚠ El síntoma que engaña: en una cola FIFO hay un tope de **20.000 mensajes en
> vuelo**. Si C4 se atrasa lo suficiente, la cola **deja de entregar** con
> `OverLimit` y parece que se vació — cuando en realidad está llena.

---

## `G-11` · El log por segundo

Además de las marcas del inbox, C4 lleva **su propio reloj en memoria** y lo
vuelca a `c4/logs/<prueba>__c4.json`. Es el gemelo del log de C3 y del
orquestador: misma forma, mismos nombres, se ponen los tres uno al lado del
otro.

```bash
curl -OJ localhost:3003/logs/g11b          # c4/logs/g11b__c4.json   ← esto
curl -OJ localhost:3003/logs/g11b__inbox   # c4/logs/g11b__inbox.json ← G-08
curl -s   localhost:3003/status            # el acumulado al instante
```

> ⚠ **Dos archivos por corrida y no son lo mismo.** `__c4.json` es el reloj del
> consumidor, en memoria, y se pierde si muere la task — por eso se vuelca cada
> pocos segundos. `__inbox.json` es el volcado del **ledger**, lo escribe el CLI
> contra Postgres y se puede regenerar siempre. Confundirlos lleva a creer que
> P4 está contestada cuando lo único que hay es un log de tiempos.

### Por qué las marcas no bastan

Las marcas `e7..e10` son ISO 8601: resolución de **milisegundo**. Verificar
Ed25519 sobre 3 KB es sub-milisegundo y el AES-GCM del sobre también. Los dos
tramos saldrían en `0 ms` y el informe diría que descifrar y verificar son
gratis. Las muestras se toman con `process.hrtime.bigint()` — monótono
(no lo mueve un ajuste de NTP a mitad de corrida) y con resolución de
nanosegundo.

Las marcas **siguen existiendo** y siguen siendo las que van a las columnas: son
lo que permite conciliar contra el outbox de C3 y lo que sobrevive al proceso.
Esto es lo *otro*: duración, no instante.

### `received`, `init` y `completed` son tres relojes

En el nivel `messages` hay **tres** columnas, y cada una la escribe un reloj
distinto. Confundirlas es la forma más fácil de leer mal este archivo:

| | Se cuenta cuando | Cómo llega |
|---|---|---|
| `received` | el **lote** llegó con el mensaje dentro | en ráfagas: los diez de un lote, a la vez |
| `init` | a **ese mensaje** le tocó su turno y empezó | repartido: el décimo empieza ~40 ms después que el primero |
| `completed` | ese mensaje **terminó**, con el desenlace que sea | repartido |

Restar `received` de `completed` no significa nada — son dos relojes. Restar
`init` de `completed` sí: son los que empezaron en este segundo y no habían
acabado al cerrarlo.

> ⚠ En la primera versión de `G-11`, `init` **era** `received`. Por eso una fila salía
> `init: 50 / completed: 50` un segundo tras otro y parecía que todo empezaba y
> acababa dentro del mismo segundo: no era eso, era que la columna venía del
> reloj del lote y no del mensaje.

En los **pasos**, el par es siempre del mismo reloj: `init` cae en el segundo en
que ese tramo arrancó y `completed` en el que terminó.

Que no cuadren dentro del mismo segundo **es el dato, no un fallo**: un lote que
entra en el segundo 5 puede cerrarse en el 7, y ese desfase *es* la latencia.
Cuando C4 se atasca, `init` mantiene su ritmo y `completed` se hunde.

De una corrida real, el segundo 3:

```
batch     init=5   completed=4     ← un lote cruzó la frontera del segundo
delete    init=5   completed=4
decrypt   init=50  completed=50
```

### Cuándo `init = completed` NO es sospechoso

Es la pregunta que este archivo provoca siempre, y tiene dos respuestas
distintas — conviene saber cuál aplica antes de desconfiar del reloj.

**1 · El tramo dura microsegundos.** La probabilidad de que una ejecución cruce
un borde de segundo es su propia duración partida por 1.000. Con `decrypt` en
0,075 ms y 50 mensajes en el segundo, se espera **un cruce cada 266 segundos**:
verlo plano no es que el reloj mienta, es aritmética. Los tramos que sí duran
milisegundos —`inbox` (3,3 ms), `message` (5,7 ms), `batch` (131 ms)— cruzan en
uno de cada tres o cuatro segundos, y **en el mismo archivo** se ve que cruzan.
Si un tramo de milisegundos nunca cruzara, *eso* sí sería para preocuparse.

Medido: corrida de 57 s y **2.480 mensajes**, cruces reales contra los que
predice la aritmética (`ejecuciones × duración ÷ 1000`):

| paso | dur. media | ejecuciones | cruces previstos | cruces reales |
|---|---:|---:|---:|---:|
| `batch` | 129,2 ms | 249 | 32,2 | **27** |
| `receive` | 120,5 ms | 249 | 30,0 | **30** |
| `delete` | 69,9 ms | 249 | 17,4 | **14** |
| `wait` | 30,8 ms | 2.480 | 76,4 | **67** |
| `message` | 5,8 ms | 2.480 | 14,5 | **13** |
| `inbox` | 4,6 ms | 2.480 | 11,5 | **10** |
| `decrypt` | 0,85 ms | 2.480 | 2,1 | **2** |
| `verify` | 0,30 ms | 2.480 | 0,7 | **0** |
| `hash` | 0,05 ms | 2.480 | 0,1 | **0** |
| `envelope` | 0,014 ms | 2.480 | 0,03 | **1** |

Once tramos y ninguno se sale de su predicción. Un reloj que imputara el segundo
en vez de medirlo no podría producir esta tabla: daría 0 cruces en todo, o los
mismos cruces en todo.

**2 · El tramo es observado, no ejecutado.** `wait` y `receive` son huecos entre
dos instantes que **ya pasaron** cuando C4 se entera: no hay un «empezó» que
situar en un segundo distinto del «terminó». Sus dos columnas son idénticas por
definición, dure el tramo 20 ms o 20 s. Van marcados en el JSON:

```json
"receive": { "init": 5, "completed": 5, "observado": true, "p50_ms": 76.9 }
```

Sin esa bandera, `receive` con 127 ms de media y cero cruces se lee exactamente
como un reloj falso.

### `crossed`: cuántas de las que cerraron venían de antes

`init: 50 / completed: 50` no dice si son **los mismos** 50. `crossed` sí:

```json
"inbox": { "init": 55, "completed": 56, "crossed": 7, "p50_ms": 3.4 }
```

Siete de los 56 que cerraron en este segundo habían **empezado en el anterior**.
No se guarda estado para saberlo: la duración ya se estaba midiendo, así que el
instante de arranque es `fin − ms` y basta comparar su segundo con el de cierre.

Se **omite cuando es 0** — un `crossed: 0` en cada paso de cada segundo son
miles de líneas diciendo que no pasó nada. Su ausencia significa cero, igual que
la de un paso que no se ejecutó.

En un tramo de microsegundos será casi siempre 0 y eso es correcto; en `receive`
(long polling) será casi siempre alto. Los dos casos son ciertos y por la misma
aritmética.

### `min_ms` y `max_ms`: la prueba de que se midió una por una

Cada paso lleva el más rápido y el más lento de la ventana, los dos **exactos
sobre todas las ejecuciones** (no sobre la muestra recortada por el techo).
Son lo que hace visible que cada mensaje costó lo suyo:

```
decrypt   min=0.041   p50=0.076   p95=0.103   max=80.243
```

Ese `max` de 80 ms con un p50 de 0,076 es un caché de data key que falló y se
fue a KMS. Un p50 solo no lo habría enseñado. Y al revés: `min_ms = max_ms` con
`n` grande significa que algo está **repitiendo** una medida en vez de medir.

`init − completed` de un paso son las ejecuciones que **entraron y no salieron**,
y hay tres motivos: el mensaje se fue por el camino del veneno
(`messages.discarded`), se dejó en la cola para reintento (`messages.retried`),
o el tramo reventó. Es lo que señala **en qué paso** se quedó un mensaje que
nunca llegó a `e10` — un veneno de firma inválida deja `verify.init` sin su
`completed` y `inbox.init` sin tocar.

### Los doce tramos

| Paso | Tramo | Unidad |
|---|---|---|
| `wait` | `e7→e7b` — lo que el mensaje esperó su turno dentro del lote | mensaje |
| `envelope` | `e7b→` — parsear y validar la envoltura, sin abrirla | mensaje |
| `decrypt` | `→e8` — KMS `Decrypt` (o caché) + AES-256-GCM | mensaje |
| `verify` | `→e9` — `GetPublicKey` (caché) + Ed25519 | mensaje |
| `hash` | recanonizar el payload y recalcular `payload_hash` | mensaje |
| `inbox` | `e9→e10` — la transacción: inbox + los cinco schemas | mensaje |
| `message` | `e7b→e10` — el trabajo del mensaje entero | mensaje |
| `dlq` | publicar el veneno y anotar el descarte | veneno |
| `stamp` | el `UPDATE` de `e10` del lote | lote |
| `delete` | `DeleteMessageBatch` | lote |
| `batch` | `e7→` — el lote entero: procesar, estampar, borrar | lote |
| `receive` | `ReceiveMessage` | ciclo |

Un paso que **no ocurrió no aparece**. En una corrida de 3.000 segundos, doce
pasos a cero por segundo son 36.000 líneas diciendo «aquí no pasó nada» — y su
ausencia informa: sin `dlq` en un segundo, en ese segundo no hubo un veneno.

### La aritmética, y dónde cuadra

```
envelope + decrypt + verify + hash + inbox  =  message
Σ message + stamp + delete                  =  batch
```

**Cuadra en el `total`, no en una fila suelta**: los tramos de un mensaje que
cruza la frontera del segundo caen repartidos entre dos filas — que es
justamente lo que `init` vs `completed` está enseñando. Medido sobre 725
mensajes reales, el desvío en el total es **0,000 %**.

`wait` queda **fuera** de esa suma a propósito: es espera, no trabajo, y sumarlo
contaría dos veces el procesamiento de los mensajes anteriores del lote.
`receive` también, porque es por ciclo.

### `receive` incluye la espera del long polling

Un ciclo vacío se pasa 20 s dentro de esa llamada esperando a que llegue algo, y
**eso no es coste de C4**: es cola vacía. Por eso solo se mide en los ciclos que
trajeron mensajes, y aun así se lee como «cuánto tardó en haber trabajo». El
ritmo de la cola se lee en `sqs.empty`: si los ciclos vacíos desaparecen, la
cola nunca se vacía y el cuello es C4.

### Un sondeo en vacío no mantiene viva una corrida

El lazo sigue sondeando **para siempre** después de que la prueba acabe. Si cada
sondeo refrescara el reloj de silencio, la corrida nunca se daría por terminada:
el síntoma no es un error, es un `cerrado_por: "en curso"` permanente, un
`duracion_s` que crece sin parar y una fila por cada 20 s de cola vacía. Medido
antes de arreglarlo: **una corrida de 10 s aparecía con 259 s**.

Así que un ciclo vacío —y un `ReceiveMessage` que revienta— se anotan mientras la
corrida siga viva, pero **no tocan el reloj de silencio**. Y de una corrida que
nunca existió no se abre archivo: un C4 arrancado antes que el orquestador no
deja en disco el log de una prueba que no ocurrió.

### KMS va aparte del tiempo

```json
"kms": { "decrypt": 8, "cache_hit": 717, "get_public_key": 1 }
```

Lo que importa aquí no es el tiempo sino la **razón**: si `decrypt` crece al
ritmo de `messages.init`, el caché de data key dejó de acertar, cada mensaje se
lleva una llamada a KMS y el cuello se muda ahí. Es la línea que decide si P3
señala a KMS o a Postgres. C3 pide una data key por lote y la reúsa, así que en
régimen `decrypt` debe quedarse en unidades mientras `cache_hit` sigue al total.

### Las reentregas se cuentan, y no son un error

```json
"payload_hash_unicos": 725, "payload_hash_repetidos": 0
```

Se comparan contra **toda la corrida**, no contra el segundo: una reentrega que
cruza la frontera del segundo sigue siendo una reentrega. Es el mismo hecho que
la columna `duplicados` del inbox, pero **fechado al segundo** — que es lo que
permite ver si las reentregas se agolpan justo cuando el visibility timeout
empieza a vencer. La entrega es al-menos-una-vez (regla 4): un duplicado es la
idempotencia funcionando, no una pérdida.

El hash que se cuenta es el **recalculado**, no el `MessageDeduplicationId`
declarado: contar reentregas con el declarado sería dejar que el emisor decida
cuántas hubo.

### El techo de muestras sí se toca aquí

C4 es el **embudo**: los 50 tenants publican a una cola y este proceso la consume
solo. Donde un C3 ve ~40 ev/s, C4 ve los 2.000 del perfil completo — cuatro veces
el techo de 500 muestras por segundo y serie. Así que los percentiles de C4 salen
de una **muestra**, y por eso `muestras` viaja al JSON al lado de `n`.

Lo que el techo **no** toca: `n`, `suma` y `max` se acumulan al entrar cada
muestra. La media y los totales son de la corrida entera aunque el p99 sea de 500
mensajes de ese segundo.

### Una corrida real, entera

725 mensajes en 8 segundos de carga, dos tenants, local:

```
batch  init=74 completed=74  p50=121.9 ms  per_batch=9.8
msgs   init=725 persist=725 dup=0 desc=0 retry=0  3.28 MB
sqs    receives=76 empty=2 failed=0 deleted=725 delete_failed=0 to_dlq=0
kms    decrypt=8 cache_hit=717 get_public_key=1

paso         init completed      p50      p99      max    suma_ms
wait          725       725   24.561   69.344  123.492    22060.6
envelope      725       725    0.010    0.026    0.065        8.8
decrypt       725       725    0.087   23.151  202.585      745.3
verify        725       725    0.165    4.144  285.631      424.0
hash          725       725    0.039    0.088    0.145       33.5
inbox         725       725    3.642   10.803   14.246     3430.6
message       725       725    3.955   37.706  497.485     4642.2
stamp          74        74    0.837    1.269    3.614       74.3
delete         74        74   67.490   91.318  218.609     6020.8
batch          74        74  114.814  171.675  576.728    10751.9
receive        74        74   83.357  191.077 3280.840    10449.0
```

Lo que se lee de ahí, y que ningún promedio por minuto habría enseñado:

- **El trabajo del mensaje son 4 ms**, no los 121 del lote. La diferencia son
  `wait` (24 ms de media esperando turno) y `delete` (67 ms, la llamada más cara
  del ciclo).
- **`delete` cuesta 16× más que persistir.** El cuello aquí no es Postgres ni
  KMS: es la API de SQS.
- **El caché de data key acierta el 99 %.** 8 `Decrypt` para 725 mensajes.
- Los `max` de `decrypt` (202 ms) y `verify` (285 ms) son la primera llamada del
  proceso repartida: el `Decrypt` y el `GetPublicKey` que se pagan una vez.

---

## El resumen en vivo

Cada `C4_RESUMEN_MS` (10 s por defecto):

```
resumen · recibidos=18 persistidos=12 duplicados=0 descartados=6
          reintentar=0 borrados=18
        | kms: decrypt=1 (cache 16) pubkey=1
        | ciclos=4 vacios=2 errores=0 bytes=61258
⚠ la DLQ tiene 30 mensajes
```

`decrypt=1 (cache 16)` es la línea que hay que mirar para saber si el caché de
data key está funcionando. Si `decrypt` crece al ritmo de `recibidos`, C3 dejó
de reusar la data key o el caché está desalojando demasiado pronto.

Los contadores del resumen viven **en memoria** y se pierden al reiniciar. Los
que responden P4 están en la base.


---

## Medido · 39 tenants, 781 msg/s, 600 s

Corrida `test-deploy-39clients-600s-6-10-1-4` del 2026-09-01. Dos réplicas de
`db.t4g.medium`, `c4_concurrencia = 8`, `c4_lote_transaccion = true`.

| tramo | | p50 | p99 |
|---|---|---|---|
| `e6→e7` | espera en la cola SQS | **23 ms** | 253 ms |
| `e7→e8` | descifrar | 1 ms | — |
| `e8→e9` | **verificar la firma Ed25519** | **1 ms** | — |
| `e9→e10` | persistir en el inbox | 24 ms | — |
| | **C4 completo** | **70 ms** | 345 ms |

**C4 no fue el cuello de botella en ningún momento.** La cola terminó en
**0 mensajes** dentro de la misma ventana de diez minutos: consumió al mismo
ritmo al que llegaba, sin acumular. La profundidad osciló entre 5 y 57 mensajes
durante toda la corrida.

Verificar la firma de cada uno de los 468 678 documentos costó **1 milisegundo**.
El invariante del Proof Ledger —que C4 pueda comprobar sin poder firmar— no
tiene coste apreciable.

### Entrega exacta

| | |
|---|---|
| Documentos en el inbox | **468 678** |
| Suma de los 39 outboxes de C3 | **468 678** |
| Diferencia | **0** |
| Duplicados | 0 · `recepciones_max = 1` |
| En la DLQ | 0 |

**Cero pérdida entre C3 y C4.** Y `recepciones_max = 1` dice algo más: SQS no
reentregó ni un mensaje, así que la corrida **no ejercitó la idempotencia del
inbox** — está ahí, pero no se probó bajo esta carga.

### Los 66 que aparecieron de más

El inbox acabó con **66 documentos más de los que el orquestador contó como
`ok`**. No es un error de conteo: son peticiones que dieron
`UND_ERR_HEADERS_TIMEOUT` en el arnés. C3 las procesó enteras y publicó sus
documentos; el orquestador simplemente dejó de esperar la respuesta.

Es la razón por la que la conciliación se hace contra **las bases** y no contra
el informe del arnés: un timeout del cliente no significa que el trabajo no se
hiciera.

### Consumo y memoria

| | |
|---|---|
| Conexiones a su RDS (máx.) | 16 |
| Memoria libre (mín.) | 1 953 MB de 4 GiB |
| Tamaño por fila del inbox | **722 B** con índices |
| Disco usado por la corrida | ~330 MB de 20 GB |

Dos réplicas sostuvieron ~390 msg/s cada una. El aviso de `c4_replicas` sigue
en pie —más réplicas no arreglan el lazo si el consumidor procesa de uno en
uno— pero con `concurrencia = 8` el caudal no fue el límite.
