# 06 · `party_id` y `payload_hash`

Los dos artefactos del **paso ② del pipeline RPF**. Se parecen —los dos son
hexadecimal, los dos salen de una función de hash— y son cosas completamente
distintas. Confundirlos es fácil y caro, así que este documento los separa.

```
                    ┌─ SHA-256      → payload_hash   la HUELLA del documento
paso ② · Hashing ───┤
                    └─ HMAC-SHA256  → party_id       el SEUDÓNIMO del emisor
```

En una línea:

| | Responde a | Cambia con |
|---|---|---|
| `party_id` | **quién** emitió | el tenant — uno por contenedor, fijo de por vida |
| `payload_hash` | **qué** se emitió | cada evento — uno por documento |

---

## `party_id` — el seudónimo del participante

### Qué es

Un campo del documento. Uno de los 16 de primer nivel, al lado de `rpf_id` y
`sequence`:

```json
"party_id": "hmac:9f2b7c41e8a35d06b1f4c92e7a08d5b33b5d80a7e29c4f1b60d53a8e14c7b2f9"
             └───┘ └────────────────────── 64 hex ──────────────────────────────┘
             prefijo                                              total: 69 caracteres
```

### De dónde sale

De una llamada a KMS, **una sola vez, al arrancar el contenedor de C3**:

```
KMS GenerateMac
  KeyId        = KMS_HMAC_KEY_ID        ← llave HMAC_256, vive en el KMS de C3
  MacAlgorithm = HMAC_SHA_256
  Message      = TENANT_ID              ← "tenant-01"
        ↓
  Mac = 32 bytes  →  64 hex  →  "hmac:" + eso
```

Se calcula al arrancar y se cachea de por vida del proceso. **No se pide por
evento.** `HMAC(tenant-01)` da siempre lo mismo, y pedírselo a KMS 2.000 veces
por segundo gastaría una cuota que la firma necesita entera para obtener
siempre el mismo string.

### Para qué existe

Para que **C4 pueda agrupar por participante sin saber quién es** (D-08).

C4 es el operador neutro: recibe eventos de los 50 tenants y necesita
contarlos por emisor —cuántos expedientes tiene cada uno, con quién negocia—
pero **no debe poder identificarlos**. Si el payload trajera `"tenant-01"` en
claro, C4 sabría exactamente de quién es cada documento.

Con el HMAC, C4 ve `hmac:9f2b…`, agrupa perfectamente, y no puede volver atrás:
la llave que produce ese valor vive en el KMS de C3 y **nunca sale del dominio
del participante**.

### Por qué el orquestador manda un placeholder

Aquí es donde entra el track `O`, y es la parte que más confunde.

**El orquestador no calcula ningún HMAC.** No tiene la llave ni debe tenerla.
Lo que hace es **reservar el hueco**:

```
ORQUESTADOR                          C3
manda el documento con               sustituye el campo
  "party_id": "hmac:000…000"    →      "party_id": "hmac:9f2b…2f9"
              └ 69 caracteres ┘                    └ 69 caracteres ┘
```

El placeholder mide **exactamente lo mismo** que el valor real. Y eso no es
un detalle estético:

> El orquestador ajusta el `padding` **al byte** para que cada documento pese
> exactamente el tamaño que se le sorteó. Si C3 sustituyera un campo de 37
> caracteres por uno de 69, el documento pesaría 32 bytes más de lo que su
> plantilla declara. **Nada fallaría de forma visible** —se firma igual, viaja
> igual, C4 lo verifica igual— pero el orquestador reportaría 3.072 bytes
> ofrecidos y C3 registraría 3.104 recibidos para el mismo evento. La
> conciliación de bytes entre los dos logs dejaría de cerrar y P1/P2
> informarían sobre un tamaño que ningún evento tuvo.

Por eso `orquestador/src/generador/pool.service.ts` falla ruidoso si el largo no cuadra, y por eso el
mapper de C3 lo comprueba en los dos extremos: el que llega y el que escribe.

### Por qué 64 hex y no 32

Antes se truncaba el HMAC a la mitad. Ya no: **va completo**.

Truncar no lo rompía —128 bits siguen siendo suficientes para un seudónimo—
pero lo apartaba del protocolo RPF, que especifica HMAC-SHA256 sin más. Y los
32 bytes extra caben de sobra: son un 1% de un documento de 3 KB, y el
`padding` los absorbe sin que el total se mueva.

Lo único que subió es el **piso**: con los 70 atributos hoja del documento, el
más chico posible son **2.024 bytes** con un solo ítem, porque ahí ya no queda
relleno de dónde recortar. El rango del perfil (`[2048, 4096]`) entra con 16
bytes de margen sobre ese piso.

---

## `payload_hash` — la huella del documento

### Qué es

**No es un campo.** No está en el documento, y no puede estarlo.

```
$ campos de una plantilla del orquestador

  counterparty   document      event_id    event_type
  items          occurred_at   origin      padding
  participant    party_id  ←   payment     rpf_id
  schema_version sequence      totals      transport

  payload_hash: NO APARECE
```

### Por qué no puede estar dentro

Porque es el hash **del documento entero**. Meterlo dentro sería pedirle a una
foto que se contenga a sí misma: al agregarlo cambiarías el documento, y al
re-hashearlo daría un valor distinto del que metiste.

Es la misma razón por la que las marcas de tiempo `e0..e6` tampoco van dentro
(regla 8). **Todo lo que se calcula _sobre_ el documento firmado vive fuera de
él.**

### De dónde sale

De C3, después de canonizar y **después** de sustituir el `party_id`:

```
payload_hash = sha256( canonicalize(payload) )    → 64 hex
```

El orden importa: si se calculara antes de la sustitución, la huella
correspondería a un documento con el placeholder — no al que viajó.

### Sus tres papeles

Es un solo valor haciendo tres trabajos, y por eso importa que sea uno solo:

**1 · Identifica el documento** dentro del protocolo RPF. Dos documentos
idénticos tienen la misma huella; uno con un byte distinto, otra.

**2 · Es el `MessageDeduplicationId` de SQS.** Y se calcula sobre el texto **en
claro**, nunca sobre el cifrado:

> AES-GCM usa un IV distinto en cada operación. El mismo evento cifrado dos
> veces produce bytes completamente distintos, así que un hash del sobre
> **jamás** detectaría un duplicado. La deduplicación por contenido de SQS es
> inútil aquí y hay que desactivarla (regla 5, D-11).

**3 · Es la clave primaria del inbox de C4.** La misma llave a los dos lados es
lo que permite conciliar outbox contra inbox — y eso es exactamente cómo se
responde **P4** («¿llegaron todos los documentos?»).

### C4 lo recalcula, no se lo cree

C3 declara el `payload_hash` como atributo del mensaje. C4 **lo vuelve a
calcular** sobre el payload que descifró y compara:

```
declarado ≠ recalculado  →  payload_hash_no_coincide  →  DLQ con alarma
```

El motivo lo dice el código de C4: *«o el emisor mintió o el JCS derivó»*. Es
la red de seguridad contra la peor avería posible de este sistema — que las
tres copias del canonicalizador se separen.

---

## Los dos, lado a lado

| | `party_id` | `payload_hash` |
|---|---|---|
| **Qué es** | un campo del documento | una huella calculada sobre él |
| **¿Está en el payload?** | sí | **no, y no puede** |
| **Función** | HMAC-SHA256 (con llave) | SHA-256 (sin llave) |
| **Entrada** | `TENANT_ID` | el documento canónico entero |
| **Cuándo se calcula** | una vez, al arrancar C3 | una vez por evento |
| **Cuántos valores hay** | 1 por tenant (50 en total) | 1 por evento (millones) |
| **Largo** | 69 car. (`hmac:` + 64 hex) | 64 hex |
| **Quién lo pone** | C3 (sobre el hueco del orquestador) | C3 |
| **Para qué sirve** | agrupar sin identificar | deduplicar y conciliar |
| **Si se rompe** | los bytes reportados mienten | se pierden eventos en silencio |

---

## El recorrido completo de un evento

```
ORQUESTADOR
  │  plantilla del pool + identidad fresca
  │  party_id = "hmac:000…000"        ← placeholder, 69 car
  │  padding ajustado al byte
  ▼  POST /events
C3
  │  ① valida el contrato y el peso
  │  ② party_id     ← el HMAC real, cacheado del arranque   [MISMO LARGO]
  │     canoniza (JCS RFC 8785)
  │     payload_hash ← sha256 del canónico
  │  ⑤ firma Ed25519 sobre el canónico
  │     cifra { payload, signature }
  ▼  SQS FIFO · MessageDeduplicationId = payload_hash
C4
  │  descifra · verifica la firma
  │  RECALCULA el payload_hash y compara
  │  INSERT ... ON CONFLICT (payload_hash) DO NOTHING   ← idempotencia
  ▼  agrupa por party_id, sin saber de quién es
```

---

## Qué pasa si se rompe cada uno

**Si el `party_id` cambia de largo**: nada falla visiblemente. Los documentos
pesan distinto de lo que se declara y toda la comparación de tamaños de la
prueba queda invalidada — sin un solo error en los logs. Es la avería más
difícil de detectar de las dos.

**Si el `payload_hash` deja de ser único por evento**: SQS FIFO descarta los
repetidos **en silencio** durante su ventana de 5 minutos. Perderías la mayor
parte de los eventos y P4 daría un falso negativo masivo. Por eso el
orquestador refresca `event_id`, `rpf_id`, `sequence` y `occurred_at` en cada
envío y **nunca** reenvía una plantilla tal cual (regla 11).

**Si el JCS de los tres servicios diverge**: los dos se rompen a la vez. El
`payload_hash` no coincide y la firma no verifica, y C4 no puede distinguir eso
de un intento de inyección: DLQ con alarma. Hay un test en cada servicio que
compara los fuentes del canonicalizador precisamente para que esto no llegue a
pasar.
