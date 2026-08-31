# 08 · Reglas que no se negocian

Las de `CLAUDE.md` que **este track sostiene**, con lo que pasa si se rompen.
Ninguna es teórica: cada una tiene código y un test detrás.

---

### 1 · Los importes son `string`, nunca `number`

JCS serializa los números como doubles. Un importe en punto flotante se
canoniza, se firma y **verifica perfectamente** — no lo atrapa nadie más abajo.
Rompe meses después, cuando ese número pase por otro formato de doble.

Es la única que puede romper la PoC en silencio. Por eso el mapper lo rechaza en
la puerta con `importe_no_es_string`, y hay un test por cada importe del
contrato.

### 2 · El outbox se escribe en la misma transacción que el estado de negocio

Si van separadas no tienes un outbox: tienes dos tablas que se desincronizan la
primera vez que el proceso muera entre una y otra.

### 3 · El commit ocurre antes de publicar

Por eso el pipeline y el relay están separados, y el repositorio del outbox **ni
siquiera importa el cliente de SQS**. Al revés daría «se publicó y luego el
commit falló»: un evento en la cola que no existe en tu base.

### 4 · La entrega es al-menos-una-vez

Los duplicados son funcionamiento normal, no anomalía. El relay puede publicar
dos veces si muere entre el envío y el `SENT`. C4 es idempotente por diseño: el
`payload_hash` es su clave primaria.

### 5 · `MessageDeduplicationId` explícito, sobre el texto en claro

AES-GCM usa un IV distinto cada vez: el mismo evento cifrado dos veces da bytes
distintos, así que la deduplicación por contenido de SQS **no detectaría nunca
un duplicado**. Hay que desactivarla y mandar el id explícito.

### 6 · Se firma primero y se cifra después

La firma cubre el documento, no un cifrado que cualquiera pudo rehacer. Por eso
viaja **dentro** del sobre.

### 7 · C3 firma y cifra pero no descifra

Es el invariante del Proof Ledger. **No lo sostiene este código**: lo sostienen
las policies de KMS. Lo que sí hace el código es dejarlo dicho — `comun/sobre.ts`
no llama a KMS a propósito, para que ni C3 ni C4 puedan importar la mitad del
otro.

⚠ `npm run e2e:kms` **no prueba esto**: corre con las credenciales de quien lo
lance. Solo se comprueba desplegado, con los roles de verdad.

### 8 · Las marcas de tiempo nunca van dentro del payload

Van en columnas del outbox. Hay un test que abre el sobre ya cifrado y comprueba
que nadie coló una marca dentro.

### 9 · Nada de `Math.random()` en lo que se firma

Un evento cuya firma no verifique tiene que ser reproducible. En C3 esto aplica
al IV y a la data key, que **no se firman** — la aleatoriedad ahí es correcta y
necesaria. Lo que se firma llega ya hecho del orquestador, con su PRNG sembrado.

### 10 · Medir en bytes, no en caracteres

`Buffer.byteLength`, siempre. Un acento son dos bytes.

---

## Y dos que aprendimos aquí

### Un solo reloj dentro de un dominio

`e5` de Postgres y `e6` de Node hacían que el tramo diera **negativo**. Dentro
de C3 todas las marcas salen del mismo proceso. M-08 acepta la deriva entre C3 y
C4 porque están en cuentas distintas; dentro de un contenedor no hay excusa.

### C3 y C4 no comparten base

Con base compartida se puede escribir una conciliación con `JOIN` que **pasa en
local y es imposible en producción**. La peor clase de prueba: la que da verde
por una razón que no existe fuera del portátil.
