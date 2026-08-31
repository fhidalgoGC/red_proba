# 05 — Reglas que no se negocian

Cada una tiene una razón concreta y romperla invalida algo. Varias están aquí
porque **ya se rompieron** durante el desarrollo y el informe mintió.

---

## 1 · Lazo abierto: nunca se espera una respuesta

```ts
enviar(tenant, documentos, bytes): boolean    // ← booleano, NO una promesa
```

En `planificador.service.ts` **nunca se hace `await` de un envío**. Si se
esperara la respuesta para mandar lo siguiente, un destino lento recibiría
menos carga y medirías un sistema que se ve sano porque nadie lo está
presionando. Se llama **omisión coordinada** y es la forma más común de que una
prueba de carga mienta.

### El corolario que costó encontrar

**Un tope de peticiones en vuelo es un lazo cerrado por la puerta de atrás.**

El emisor tenía `concurrencia_por_tenant: 256`. Parecía una válvula de
seguridad razonable. Pero cada respuesta que llegaba liberaba un hueco, así que
la velocidad del destino gobernaba el ritmo de envío — exactamente lo que la
regla prohíbe.

El síntoma era cruel: con `{"client": {"min": 100, "max": 200}}` el informe
decía `sent: 45`. La cuota de 200 se ofrecía entera —el rango se respetaba—
pero 155 por segundo se descartaban antes de salir al cable, y el veredicto
acusaba al destino cuando el cuello era el propio emisor.

**Ahora el tope es 0 por defecto.** El reloj manda y se envía la cuota entera
pase lo que pase. Si el destino no da abasto, el daño aparece donde debe: en la
**latencia** y en los **timeouts**, no como eventos que nunca salieron.

Se puede poner un tope a mano como válvula, pero es una decisión explícita y el
informe la delata en `sent.dropped_saturation`.

---

## 2 · La cuota del segundo es exacta, no una media

El rango de `request.client` acota el **número de eventos**, no la media de un
proceso.

Antes esto sorteaba intervalos exponenciales con media λ — un proceso de
Poisson de verdad. Pero el conteo por segundo de un Poisson es una variable
aleatoria con desviación √λ: **con un máximo de 80 salían segundos de 94**, y
con razón parecía un fallo.

Ahora se sortea la cuota (un entero dentro del rango) y después se reparten sus
instantes dentro del segundo. **No se pierde la ráfaga**: por la propiedad de
uniformidad condicional, un Poisson del que se conocen sus N llegadas las tiene
distribuidas uniformemente, así que los racimos son los mismos.

Lo que cambia es que la varianza entre segundos ya no la pone Poisson, la pone
el rango. Que es lo que se pide.

---

## 3 · Un segundo es una caja cerrada

Lo que no salga antes de que cambie el segundo **no se arrastra**: se cuenta
como `dropped_lag` y se descarta.

Arrastrarlo permitiría que un segundo superara su cuota máxima con deuda del
anterior, y el rango dejaría de significar nada.

Y como corolario: **nada se programa en el último tick del segundo**. La ventana
es de 990 ms, no 1000. Un evento en el milisegundo 999,7 no tendría ningún tick
por delante y moriría sin disparar — era pérdida sistemática de 1-3 eventos por
segundo que el informe reportaba como «el arnés no da abasto».

---

## 4 · El pool nunca reenvía una plantilla tal cual

Cada envío refresca `event_id`, `rpf_id`, `sequence` y `occurred_at`.

`MessageDeduplicationId` es el sha256 del payload canónico **en claro**. Dos
envíos del mismo documento producen el mismo `payload_hash` y SQS FIFO descarta el
segundo **en silencio** durante su ventana de 5 minutos. Perderías la mayor
parte de los eventos y P4 daría un falso negativo masivo, **sin un solo error
en los logs**.

El receptor de C3 cuenta `event_id` repetidos justamente para detectar si esto
se rompe.

---

## 5 · Un consumidor, un flujo de PRNG

Cuatro flujos derivados de la misma semilla por XOR. Compartir uno acopla cosas
que no tienen relación, y el acoplamiento es invisible.

Pasó de verdad: `elegir` (qué plantilla se manda) y `muestrear` (a qué evento
se le verifica el tamaño) compartían flujo. Con `tasa_verificacion: 0` cada
envío consumía un número; con `0.01`, dos. Es decir, **cambiar un parámetro de
diagnóstico cambiaba qué plantillas se enviaban**, y nada en la salida lo
delataba.

---

## 6 · El orquestador no reintenta

`envio.reintentos: 0`.

Un reintento cuenta el mismo evento dos veces como carga ofrecida y falsea la
comparación ofrecido/aceptado, que es el resultado principal de la prueba.

---

## 7 · Los importes son `string`, nunca `number`

JCS serializa números como doubles de ECMAScript; un importe calculado en punto
flotante puede salir como `0.30000000000000004` y la firma dejaría de
verificar. Toda la aritmética va en **centavos enteros** y solo se formatea al
final.

La `access_key` de 44 dígitos, por lo mismo: como número pierde los últimos.

---

## 8 · Se mide en bytes, no en caracteres

`Buffer.byteLength`, nunca `string.length`. Un acento son dos bytes, y en
razones sociales brasileñas los hay. Por eso los nombres del generador van sin
acentos: para que el tamaño no dependa de qué razón social salió sorteada.

---

## 9 · `completed` es cualquier código; `failed` no es `completed`

Un 429 es una respuesta: la petición terminó. Un timeout no lo es.

Confundirlos borraría la diferencia entre «el destino me dijo que no» y «el
destino no dijo nada», que son dos diagnósticos distintos. El desglose por
código va en `ok` / `not_ok`.

---

## 10 · El informe cierra cuando drena, no cuando acaba el reloj

Si cerrara a los `seconds` exactos, las respuestas que seguían en vuelo
quedarían fuera y `sent` no cuadraría nunca con `completed`.

Hay un techo de `timeout + 2 s` por si algo no vuelve. Si vence, el informe lo
dice —`cerrado_por: "fin del batch (quedaron respuestas sin volver)"`— en vez
de presentarse como completo.

---

## 11 · Los tres niveles del informe están encadenados

`seconds` es lo medido; `minutes` suma sus segundos; `total` suma sus minutos.

Si cada nivel se contara por su cuenta podrían discrepar y no habría manera de
saber cuál miente. Encadenados, un descuadre acusa a la agregación y nunca a la
medición.

---

## 12 · Un id de batch no se sobrescribe

Repetir un id devuelve **409**. Sin esa comprobación, el informe anterior se
perdería en silencio — es pérdida de datos, no una molestia.

---

## Lo que estas reglas protegen

Las cuatro preguntas de la PoC:

| | |
|---|---|
| **P1** | ¿Cuánto tarda un documento de extremo a extremo? |
| **P2** | ¿A qué ritmo sostenido procesa el sistema? |
| **P3** | ¿Dónde está el límite y qué componente se satura primero? |
| **P4** | ¿Llegaron todos los documentos a C4? |

Si al final hay contenedores que corrieron pero esas preguntas no tienen
respuesta, la PoC falló.
