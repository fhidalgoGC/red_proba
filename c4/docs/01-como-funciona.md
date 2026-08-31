# 01 · Cómo funciona

C4 es un lazo. No hay más estructura que ésa: pide un lote, lo procesa en
serie, borra lo que quedó asentado, vuelve a pedir.

```
while (corriendo) {
  ReceiveMessage(lote 10, long polling 20 s)
  para cada mensaje, EN SERIE:  procesar
  estampar e10 del lote entero
  DeleteMessageBatch(lo que quedó asentado)
}
```

## Por qué un `while` y no un `setInterval`

Con intervalo, dos ciclos se solapan en cuanto uno tarda más que el periodo, y
el **mismo mensaje se procesa dos veces**. El inbox lo absorbería —para eso
existe— pero el duplicado ya no vendría del contrato de al-menos-una-vez sino
de un bug propio, y en los contadores los dos casos se ven idénticos. Un
`await` dentro de un `while` no puede solaparse consigo mismo.

## Por qué el lote se procesa en serie

FIFO garantiza orden **dentro de un grupo**, y procesar el lote en paralelo lo
perdería. Además, el paralelismo real de esta PoC son los 50 tenants
publicando, no los 10 mensajes de un lote: ganar ahí no movería el número que
la prueba busca.

Tiene un coste medible, y está medido — ver [04 · Medición](04-medicion.md).

---

## El camino de un mensaje

```
e7    llegó el LOTE
e7b   le toca a ESTE mensaje
 │
 ├─ 1. ¿tiene forma de sobre?        no ──→ DLQ + alarma   (no_es_sobre)
 ├─ 2. Decrypt de la edk (cache) + AES-256-GCM
 │     e8  descifrado                falla ─→ DLQ + alarma  (no_descifra)
 ├─ 3. verificación Ed25519 LOCAL
 │     e9  verificado                falla ─→ DLQ + alarma  (firma_invalida)
 │                                   llave ─→ DLQ + alarma  (llave_no_aceptada)
 ├─ 4. ¿grupo == rpf_id firmado?     no ──→ DLQ + alarma   (rpf_id_no_coincide)
 ├─ 5. ¿dedup declarado == recalculado?  no ─→ DLQ + alarma (dedup_no_coincide)
 ├─ 6. ¿rpf_id es un UUID?           no ──→ DLQ + alarma   (rpf_id_invalido)
 │
 └─ 7. [ TRANSACCIÓN: inbox + los cinco schemas ]
       e10  DESPUÉS del COMMIT       falla ─→ NO borrar, que SQS reentregue
       DeleteMessageBatch
```

Siete guardas, y **la diferencia entre ellas no es de severidad sino de qué
hacer después**. Seis mandan a la DLQ y borran; la séptima no borra.

### Las seis primeras: veneno determinista

Un sobre que no abre con la llave correcta no va a abrir la segunda vez
tampoco. Un `rpf_id` que no es un UUID no se vuelve UUID esperando. **Un dato
inválido no mejora con el tiempo.**

Por eso salen de la cola principal en el acto. Ver
[G-07 en 06-reglas](06-reglas.md#g-07--la-dlq-tiene-dos-caminos-y-son-distintos)
para por qué dejarlos al redrive automático sería mucho peor que un
desperdicio.

### La séptima: transitorio

Que la base no responda **sí** mejora con el tiempo. Ahí C4 no hace nada: no
borra el mensaje y deja que venza el visibility timeout. SQS lo reentrega, y a
la quinta recepción el `redrive_policy` lo manda solo a la DLQ, sin que C4
tenga que decidir nada.

> Confundir los dos casos es el error caro. Borrar un fallo transitorio
> convierte la entrega en como-mucho-una-vez y **la pérdida deja de verse en
> P4**. Dejar un veneno en la cola congela su expediente cinco minutos y
> **G-05 reporta un hueco que no existe**.

---

## Las guardas 4, 5 y 6, que no son obvias

Las tres comprueban que **lo que el sobre dice por fuera es lo que dice por
dentro**. Los atributos del mensaje viajan en claro y los escribió quien
publicó; el payload va firmado. Si no coinciden, alguien mintió o algo derivó.

### 4 · `MessageGroupId` contra el `rpf_id` firmado

`MessageGroupId = rpf_id` es lo que hace que FIFO ordene por expediente. Si el
grupo no es el `rpf_id` del documento, **el orden se está manteniendo sobre un
agrupamiento que no existe**, y G-05 mediría huecos de algo imaginario.

### 5 · El `payload_hash` se recalcula, no se cree

Es la clave primaria del inbox. Aceptar el declarado dejaría la idempotencia
—lo único que impide duplicar un asiento fiscal— **en manos del emisor**.

Si el recalculado no coincide con el declarado hay dos causas posibles, y la
segunda es la grave:

1. el emisor mintió, o
2. **los dos lados canonizan distinto**.

La deriva del JCS no se manifiesta como «hay dos implementaciones»: se
manifiesta como firmas que dejan de verificar, y eso es indistinguible de un
intento de inyección. Esta guarda la convierte en un mensaje explícito. Hay
además un test que compara los dos archivos — ver [07 · Pruebas](07-pruebas.md).

### 6 · `rpf_id` tiene que ser un UUID

Sin esta guarda, un `rpf_id` mal formado hace que Postgres rechace la INSERT, y
ese rechazo **se leería como fallo transitorio**: el mensaje volvería a la cola
y se reintentaría para siempre. Lo mismo con `occurred_at`, que se normaliza o
se guarda como null.

Es una guarda de tipos que existe por una razón de flujo de control, no de
tipos.

---

## Cierre ordenado

Fargate da 30 segundos tras el SIGTERM. C4 aborta el `ReceiveMessage` en vuelo
y espera a que el ciclo actual termine de borrar lo que ya asentó. Salir en
medio deja mensajes persistidos y sin borrar, que reaparecen y se cuentan dos
veces.

> **Un bug que esto tuvo y que la prueba destapó.** La guarda de idempotencia
> del cierre era el propio flag `corriendo`. Cuando el lazo paraba por su
> cuenta, `corriendo` ya estaba en `false`: el cierre se creía hecho, volvía
> sin limpiar nada, y el intervalo del resumen dejaba vivo el event loop para
> siempre. En Fargate el síntoma habría sido **un contenedor que ignora el
> SIGTERM y muere por SIGKILL a los 30 s**, en mitad de un lote. Ahora la
> guarda es un flag propio, `cerrado`.
