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
