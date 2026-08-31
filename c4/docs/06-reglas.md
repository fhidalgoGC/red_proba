# 06 · Reglas que no se negocian

Cada una tiene una razón concreta y romperla invalida algo. Las del proyecto
están en [CLAUDE.md](../../CLAUDE.md); éstas son las que **C4** sostiene o de
las que depende.

---

## 1 · El invariante: C4 descifra, nunca firma

Su rol de IAM no tiene `kms:Sign` sobre la llave Ed25519 de C3, y la key policy
de esa llave lo niega explícitamente.

**Por qué no es negociable:** es el Proof Ledger entero. Un operador neutro que
pudiera firmar podría fabricar un asiento indistinguible de uno del
participante, y la firma dejaría de probar nada.

Vive en las policies, no en el código — pero el código lo hace visible: C4 solo
usa `GetPublicKey`, y verifica en local.

---

## 2 · El `payload_hash` se recalcula, no se cree

Es la clave primaria del inbox. Aceptar el que viene declarado en el mensaje
dejaría **la idempotencia en manos del emisor**.

**Qué se rompe si no:** cualquiera que publique podría duplicar un asiento
fiscal simplemente declarando un `payload_hash` nuevo para el mismo documento.

Y si el recalculado no coincide, el mensaje explícito importa: o el emisor
mintió, **o los dos lados canonizan distinto**. La segunda es la deriva del
JCS, que si pasa inadvertida rompe la firma de todo lo que venga después.

---

## 3 · Inbox y proyección, en la misma transacción

Es la regla 2 del proyecto vista desde el otro lado.

**Qué se rompe si no:** un fallo entre las dos escrituras deja un `payload_hash`
marcado como visto y un journal sin el asiento. El reintento lo vería como
duplicado y **no lo escribiría nunca**. El evento quedaría contado en P4 y
ausente del libro — la peor combinación posible, porque los números dicen que
está.

---

## 4 · Se borra DESPUÉS de persistir, nunca antes

**Qué se rompe si no:** la entrega pasa de al-menos-una-vez a
como-mucho-una-vez, y **una pérdida deja de verse en P4**. El duplicado es un
problema que el inbox resuelve; la pérdida silenciosa no la resuelve nadie.

---

## 5 · Los duplicados son funcionamiento normal, no anomalía

La entrega es al-menos-una-vez por diseño. El relay de C3 reintenta y eso es
normal.

**Qué se rompe si se tratan como error:** los descartarías o los alarmarías, y
en cualquiera de los dos casos el ruido taparía los descartes que sí importan.
Se **cuentan** (`inbox.duplicados`) porque el conteo es la prueba de que el
contrato está ocurriendo de verdad.

---

## 6 · Las marcas de tiempo nunca van dentro del payload

El payload va firmado. Meterle metadatos de medición cambiaría lo que se firma.

Van en columnas del inbox. Y los metadatos de descarte que C4 añade al
republicar en la DLQ van en **`MessageAttributes`**, fuera del cuerpo, por lo
mismo.

---

## 7 · Un dato inválido es veneno, no un fallo transitorio

Un `rpf_id` que no es UUID, una fecha que Postgres no sabe leer, un sobre que
no abre: ninguno mejora esperando.

**Qué se rompe si no se distingue:** Postgres rechaza la INSERT, el rechazo se
lee como «la base falló», el mensaje vuelve a la cola y se reintenta **para
siempre** —o hasta agotar `maxReceiveCount`, quemando cinco recepciones y cinco
minutos de la cabeza de su grupo.

---

## G-07 · La DLQ tiene dos caminos, y son distintos

| Caso | Quién mueve el mensaje | C4 borra de la principal |
|---|---|---|
| Falla la **proyección** (base caída, pool agotado) | **SQS**, por redrive automático a las 5 recepciones | ❌ lo deja vencer |
| No **descifra** / no **verifica** / no cuadra | **C4**, `SendMessage` explícito + alarma | ✅ en el acto |

### Por qué el veneno se manda a mano

`MessageGroupId = rpf_id`, y en FIFO **un mensaje sin borrar bloquea la cabeza
de su grupo**.

Dejar el veneno al redrive automático cuesta 5 recepciones × 60 s de visibility
= **cinco minutos con toda la secuencia de ese expediente congelada**. Y G-05
reportaría un hueco que no es un hueco: un falso positivo en la única métrica
que afirma que el orden se mantuvo.

Se publica en la DLQ **antes** de borrar de la principal. Al revés, un crash
entre las dos operaciones pierde la evidencia — y la evidencia es todo lo que
este camino produce.

### Por qué el conteo no vive en la cola

Al republicar se conserva el `payload_hash` original. Si el mismo veneno llega dos
veces, el segundo envío a la DLQ **se descarta en silencio durante cinco
minutos**. Es lo deseable —no se duplica la evidencia— pero implica que la
profundidad de la DLQ **no sirve para contar**. El conteo vive en la tabla
`descartes`.

### Por qué C4 no consume la DLQ

Leerla y borrarla destruiría justamente la evidencia para la que existe. C4
**mira** la profundidad con `GetQueueAttributes` y la reporta en el resumen.
Drenarla es una herramienta aparte y manual (`test/drenar-dlq.ts`), porque
tiene que ser un acto deliberado de alguien y no un efecto secundario de que el
worker siga corriendo.

### La alarma no distingue los dos casos por profundidad

Ambos caminos terminan en la misma DLQ, así que una alarma sobre `depth > 0`
dispararía para los dos. La distinción está en el atributo `motivo` del mensaje
y en la columna `descartes.alarma`; con un metric filter sobre el log de C4 se
separa sin añadir infraestructura. La alternativa —una cola `-poison.fifo`
aparte, ya que en el caso cripto C4 publica a mano y no está obligado a usar el
target del redrive— daría una alarma limpia a cambio de un recurso más.

---

## Lo que C4 NO demuestra

- **No hay `/health`.** `BdService.viva()` existe y nadie lo llama: sin
  servidor HTTP no hay dónde colgarlo. Cuando la task definition tenga health
  check, ahí se conecta.
- **No hay backpressure.** Si Postgres se pone lento, C4 sigue pidiendo lotes
  de 10 y acumulando reintentos hasta el redrive. Con 20.000 mensajes en vuelo
  la cola deja de entregar con `OverLimit` y el síntoma **parece** que se vació.
- **`shared_map` cuenta expedientes por `sequence <= 1`.** Si un expediente
  empezara en otro número, el conteo de expedientes se desviaría; el de eventos
  no.
- **El JCS sigue duplicado** entre `c4/src/comun/jcs.ts` y el del orquestador.
  Hay un test que falla si divergen, pero la solución de verdad es un paquete
  compartido — y eso espera a que C3 exista.
