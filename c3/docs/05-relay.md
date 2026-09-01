# 05 · El relay

Lee el outbox y publica en la cola FIFO de C4. Vive en el **mismo proceso** que
el API: son un `@Interval` y un handler, no dos contenedores (D-07).

---

## Las tres cosas que no son opcionales

### 1 · El `finally`

```ts
this.ocupado = true;
try   { do { n = await this.publicarLote(); } while (n > 0); }
catch (e) { this.logger.error(...); }
finally   { this.ocupado = false; }      // ⚠
```

Sin él, una excepción deja `ocupado` en `true` **para siempre**: el relay se
congela, el health sigue en verde y los eventos se acumulan en silencio. Es el
peor fallo posible de este archivo porque **no produce ni un solo error
visible**.

Hay un test que revienta el publicador a propósito y comprueba que el guardia
queda libre.

### 2 · El drenado

Sin el `do…while`, el techo son 10 mensajes por tick — **20/s por contenedor**
con `OUTBOX_POLL_MS=500`, sin importar cuánto aguanten la base o la cola.
Medirías el periodo del timer, no la arquitectura.

Con drenado, 25 filas salen en **un solo tick**: tres llamadas de 10, 10 y 5.

### 3 · Los dos backoffs, separados

| | Dónde | Alcance | Protege de |
|---|---|---|---|
| `attempts` / `next_attempt` | **la base** | una fila | que un evento problemático gire en bucle |
| circuit breaker | **memoria** | toda la dependencia | que sigas martillando un SQS caído |

**La regla**: si el problema es de la fila, va a la base; si es de la
dependencia, va en memoria. Sin lo segundo, una caída de SQS de quince minutos
manda **todas** las filas a `FAILED` por un problema que no era de ellas.

---

## El reclamo

```sql
WITH lote AS (
  SELECT id FROM outbox
   WHERE status = 'PENDING' AND next_attempt <= now()
   ORDER BY created_at
   LIMIT $1  FOR UPDATE SKIP LOCKED
)
UPDATE outbox o
   SET attempts     = o.attempts + 1,
       next_attempt = now() + (interval '1 second'
                     * least(power(2, o.attempts), $2::numeric)
                     * (0.5 + random())),
       e5_reclamado = $3::timestamptz
  FROM lote WHERE o.id = lote.id
 RETURNING o.id, o.rpf_id, o.payload_hash, o.envelope, o.attempts;
```

### `attempts + 1` al RECLAMAR, no al fallar

Si se incrementara al fallar, el `ROLLBACK` de esa transacción **desharía el
contador** y el reintento sería inmediato en vez de escalonado: una fila
problemática giraría en bucle a toda velocidad y el relay no avanzaría nunca.

### Este `UPDATE` hace commit ANTES de publicar

A partir de ahí hay tres desenlaces y los tres son sanos:

| Caso | Qué pasa |
|---|---|
| Publica bien | Una segunda transacción la marca `SENT` |
| Falla la publicación | Nada. Ya tiene `attempts+1` y `next_attempt` futuro: se reintenta sola |
| El contenedor muere a media publicación | Idéntico. Se recupera solo |

Por eso **no hace falta transacción autónoma ni lógica de compensación**.

### `SKIP LOCKED` y el jitter

`SKIP LOCKED` evita que dos relays tomen las mismas filas — hay un test que
lanza dos a la vez y comprueba que ninguna fila la toman los dos.

El `random()` evita el thundering herd: cuando SQS devuelve throttling, los 50
contenedores fallan casi a la vez y sin jitter reintentarían **todos en el mismo
instante**.

| intento | espera base | con jitter |
|---|---|---|
| 1 | 1 s | 0,5 – 1,5 s |
| 5 | 16 s | 8 – 24 s |
| 9+ | 300 s (techo) | 150 – 450 s |

---

## La publicación

`SendMessageBatch`, hasta 10 mensajes. Con sobres de ~4,7 KB caben con muchísimo
margen bajo los 256 KB.

```
MessageGroupId            = rpf_id         ordena los eventos del expediente
MessageDeduplicationId    = payload_hash   sha256 del canónico EN CLARO
MessageAttributes.prueba  = outbox.prueba  el id de corrida  (opcional)
```

**Los tres van en claro**, y no es un descuido: el cuerpo está cifrado, así que
SQS no puede leer nada de él. Si los dos primeros viajaran dentro, la cola no
tendría de dónde sacar ni el orden ni la deduplicación.

### El tercero: el id de corrida cruzando al otro dominio

`prueba` es el `x-prueba-id` que generó el orquestador, viajó en la cabecera
hasta C3 y se guardó en `outbox.prueba` (esa columna existe justo por esto: el
relay corre en su propio timer y no tiene la petición delante). Aquí sale de la
fila reclamada y sigue hasta C4.

**Para qué.** C4 es **uno** para los 50 tenants y consume una cola compartida.
Sin este atributo, todo lo que mide cae en un único montón: dos corridas
seguidas quedan sumadas en el mismo archivo y P2 de la segunda sale inflada. Con
él, C4 escribe `<prueba>__c4.json` y guarda el id en `inbox.prueba`, que es lo
que hace exacto el corte de su informe (`G-08`).

**Fuera del payload, y eso no se negocia.** El payload va firmado: meterle el id
de la corrida cambiaría lo que se firma (regla 8) y además dejaría metadato de la
prueba dentro del asiento fiscal que guarda el operador neutro.

**No toca el dedup.** `MessageDeduplicationId` es explícito, así que añadir
atributos no cambia lo que SQS considera duplicado. Si la deduplicación fuera por
contenido, este atributo la habría roto en silencio.

Es opcional: una fila sin `prueba` —una corrida lanzada sin cabecera— sale sin el
atributo, y C4 la contabiliza bajo `sin-id`.

### Un envío parcial es NORMAL

La respuesta trae `Successful` **y** `Failed` a la vez, y hay que mirar los dos.
Tratar la llamada como todo-o-nada marcaría como fallidos mensajes que SQS ya
aceptó — y entonces se reenviarían. Funcionaría, por accidente, gracias a la
deduplicación.

### Errores permanentes

```
InvalidParameterValue · InvalidMessageContents · AccessDenied
QueueDoesNotExist · UnsupportedOperation · KMSAccessDenied · …
```

Van **directo a `FAILED`** sin gastar los intentos que les quedan. Reintentar
diez veces un `InvalidParameterValue` no lo arregla: solo retrasa quince minutos
el momento de enterarte, con la fila girando mientras tanto.

Se combina con el `SenderFault` que devuelve SQS, para no depender de una sola
fuente.

**Los dos que de verdad se van a pegar en esta PoC** son de configuración:
`AccessDenied` cross-account —la resource policy de la cola o el permiso de
`kms:GenerateDataKey`— y `QueueDoesNotExist`.

---

## El circuit breaker

Se abre cuando **no pasa NI UNA** del lote, no cuando falla una fila. Una fila
mala es problema de la fila y ya tiene su backoff en la base; que no pase
ninguna es síntoma de que la dependencia está caída.

```ts
this.fallosSeguidos++;
this.pausaHasta = Date.now() + Math.min(2 ** this.fallosSeguidos * 250, 30_000);
```

Se cierra en cuanto vuelve a pasar algo.

---

## El purgado

```ts
@Cron(CronExpression.EVERY_HOUR)
```

Borra `SENT` de más de dos horas y manda a `FAILED` lo que agotó sus intentos.

**No corre en el mismo bucle que publica**: borrar mientras publicas mete
contención de vacuum justo bajo carga, que es cuando menos conviene.

Y el paso a `FAILED` no es opcional: sin él, una fila agotada se reintenta para
siempre y el relay se atasca sobre el mismo lote mientras la cola crece por
detrás.

---

## C-07 · el cierre ordenado

Fargate da 30 segundos. Al recibir `SIGTERM` se deja de tomar trabajo nuevo; el
tick en vuelo termina solo, y lo que no llegue a publicarse **se queda
`PENDING`** con su `next_attempt`. Otro contenedor, o éste al reiniciar, lo
toma.

Nada se pierde porque nada se borró del outbox.


---

## Medido · el relay es el 86 % de la latencia de C3

Corrida de 39 tenants a 781 ev/s durante 600 s, mediana por documento sobre
468 678:

| tramo | | p50 |
|---|---|---|
| `e0→e1` | canonizar (JCS) | < 1 ms |
| `e1→e2` | **firmar** con KMS | 6 ms |
| `e2→e3` | cifrar AES-256-GCM | < 1 ms |
| `e3→e4` | commit del outbox | 8 ms |
| **`e4→e5`** | **espera a que el relay reclame** | **227 ms** |
| `e5→e6` | publicar a SQS | 16 ms |
| | **C3 completo** | **263 ms** |

**No es saturación, es el periodo del temporizador.** El relay despierta cada
`OUTBOX_POLL_MS = 500`, así que una fila espera de media medio periodo: 250 ms
teóricos, 227 medidos. Los 39 tenants dieron entre **221 y 236 ms** — quince
milisegundos de dispersión sobre casi medio millón de documentos. Eso no es un
sistema bajo presión.

**Bajar `OUTBOX_POLL_MS` a 100 recortaría ~180 ms del extremo a extremo** sin
tocar arquitectura ni gastar más. Es la perilla que más mueve la latencia de
toda la PoC.

⚠ El cliente **no** espera esos 263 ms: C3 contesta `202` en **29 ms**, en
cuanto el documento tiene commit. El resto ocurre después, y por eso el evento
sobrevive aunque la tarea muera — ya está en disco.

### El drenado funcionó

`0 pendientes` y `0 fallidos` en las 39 bases, con `intentos_max = 1`: ninguna
fila se quedó atascada ni necesitó un segundo intento. A 20 ev/s por tenant el
lazo de drenado va sobrado — el techo de «10 mensajes por tick» que el drenado
existe para evitar no se acercó.
