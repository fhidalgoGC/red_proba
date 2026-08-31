# 02 — Payload y sobre

## Requisito

> **⚠ CAMBIO DE DISEÑO.** Dos cosas cambiaron respecto de la versión original
> de este documento:
>
> 1. **Quién genera**: ya no es C3, es el **orquestador**. Ver
>    [04-orquestador](04-orquestador.md).
> 2. **El tamaño ya no es fijo**: se sortea en un rango. El defecto es
>    `[2048, 4096]`, y un tamaño único sigue siendo expresable
>    (`tamano_bytes: 4096`).
> 3. **El documento tiene 70 atributos hoja fijos**, no ~52: se añadieron
>    dirección postal de las dos partes, el bloque `taxes` (ST, FCP, DIFAL y
>    retenciones), el acuse `authorization` de la SEFAZ y `references`.

Cada evento pesa **exactamente el tamaño que le tocó** en su forma canónica. El
contenido es aleatorio y de largo variable; un campo `padding` absorbe la
diferencia.

| | |
|---|---|
| Tamaño canónico | sorteado en `[2048, 4096]`, exacto por evento |
| Techo | **4.096 bytes** — límite de `kms:Sign` con `MessageType: RAW` |
| **Piso real, medido** | **2.024 bytes** — el documento con 1 ítem, peor caso |
| Esqueleto sin ítems | 1.864 bytes (peor caso) |
| Atributos hoja | **70 fijos**, +8 por ítem |
| Margen al límite de SQS | 62× en el peor caso (256 KB) |

### Por qué 2 KB es el piso

El esqueleto del documento fiscal — los 70 atributos hoja, sin un solo ítem —
pesa hasta **1.864 bytes canónicos**. Con el ítem mínimo son **2.024**. Y un
documento fiscal sin ítems no existe.

Pedir plantillas por debajo obligaría a mutilar el documento, y **un documento
mutilado no compara con nada**: la firma, el cifrado y el tamaño en cola
dejarían de representar el caso real. El mínimo admisible es **2.032** (2.024 +
8 bytes de relleno reservado), y la config lo rechaza por debajo. Los 2 KB del
defecto entran con 16 bytes de margen.

Los tres números son **medidos, no estimados**, y sobre el peor caso: el
esqueleto oscila ~25 bytes según el largo de los importes, del número de puerta
y del nombre de calle. Un piso calibrado con el caso medio pasa mil plantillas y
revienta en la dos mil, a mitad del arranque del pool.

### Por qué 4 KB es el techo

No es un número de comodidad. `kms:Sign` con `MessageType: RAW` —el que exige
`ED25519_SHA_512`— acepta mensajes de 0 a 4.096 bytes. A 4.096 bytes canónicos
la firma entra justa, con **margen cero**. Un byte más y falla en C3, con un
error de KMS que no apunta al generador. Ir más arriba obliga a
`ED25519_PH_SHA_512` con digest, y los dos `MessageType` no son intercambiables:
C3 y C4 tendrían que cambiar a la vez.

### Por qué variar el tamaño

Un flujo real de documentos fiscales no tiene todos el mismo peso. Con tamaño
único, **eventos/s y MB/s son la misma métrica** y no se pueden distinguir dos
cuellos de botella muy distintos:

| Se aplana primero | El límite es |
|---|---|
| eventos/s | **por operación** — la firma de KMS |
| MB/s | **por byte** — cifrado, red, cola |

Con tamaño variado las dos series se separan, y esa separación es la que
responde P3.

## Forma del documento

Documento fiscal brasileño sintético. Ver `payload-ejemplo.json` para el
ejemplo completo. Bloques de primer nivel:

```
rpf_id            uuid      identificador del expediente → MessageGroupId
event_id          uuid
event_type        string
schema_version    string
occurred_at       iso8601
sequence          int       orden dentro del rpf_id → detección de huecos
party_id          string    pseudónimo HMAC-SHA256 del participante (paso ②)
                            ver 09-party-id-y-payload-hash.md
participant       {}        cnpj, ie, legal_name, municipality_code, uf
counterparty      {}        cnpj, ie, legal_name, uf
document          {}        model, series, number, access_key, cfop, nature…
totals            {}        products, discount, freight, tax_base, icms, ipi…
items             []        line, code, description, ncm, unit, quantity…
transport         {}        mode, carrier_cnpj, vehicle_plate, gross_weight
payment           {}        method, installments, due_first
origin            {}        system, version, environment
padding           string    relleno base64 para llegar al tamaño sorteado
```

## Reglas del payload

### PL-01 · El relleno usa alfabeto base64, no bytes crudos

Dos razones, ambas de aritmética:

- Base64 es **ASCII puro**: 1 carácter = 1 byte, el ajuste sale exacto.
- Ninguno de sus caracteres **necesita escape en JSON**. Con bytes crudos, una
  comilla o una barra se escaparían al serializar y el evento saldría más
  grande de lo calculado.

### PL-02 · Se mide en bytes, no en caracteres

`Buffer.byteLength`, nunca `string.length`. Si un campo trae acentos — y en
razones sociales brasileñas los trae — un carácter son dos bytes y el conteo se
rompe. Por eso los nombres del generador van sin acentos: para que el tamaño no
dependa de qué razón social salió sorteada.

### PL-03 · Los importes son `string`, nunca `number`

`"18450.00"`, no `18450.00`. JCS serializa números como doubles de ECMAScript;
un importe calculado en punto flotante puede salir como `0.30000000000000004` y
la firma dejaría de verificar. Toda la aritmética va en **centavos enteros** y
solo se formatea al final.

La `access_key` de 44 dígitos, por lo mismo: como número pierde los últimos.

### PL-04 · El hash y la firma van fuera del payload

Meter `payload_hash` dentro del payload es circular: no puedes hashear un
objeto si el hash está adentro. Hash, firma, `key_id` y algoritmo pertenecen al
**sobre**.

### PL-05 · El generador es determinista

PRNG con semilla, no `Math.random()`. Cuando una firma no verifique a media
prueba vas a necesitar regenerar exactamente ese payload.

El **relleno** sí usa `randomBytes`: no se firma su contenido, solo importa su
longitud.

## Ajuste a tamaño exacto

```ts
const TARGET = 4096;   // el techo; en la PoC se sortea en [2048, 4096]
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function ajustarATamano<T extends object>(
  evento: T,
  canonicalize: (o: unknown) => string,   // el MISMO JCS que usa el Signer
  target = TARGET,
): T & { padding: string } {

  // 1. Cuánto pesa ya, contando el envoltorio del campo.
  //    `,"padding":""` son 14 bytes que salen del presupuesto.
  const conVacio = Buffer.byteLength(
    canonicalize({ ...evento, padding: '' }), 'utf8',
  );

  // 2. La diferencia, carácter a carácter.
  const faltan = target - conVacio;
  if (faltan < 0) {
    throw new Error(`pesa ${conVacio} sin relleno, objetivo ${target}`);
  }

  const buf = randomBytes(faltan);
  let padding = '';
  for (let i = 0; i < faltan; i++) padding += B64[buf[i] & 63];

  const salida = { ...evento, padding };

  // 3. Verificar. Si esto salta, el canonicalizador no es el que asumiste —
  //    y detectarlo aquí cuesta mucho menos que detectarlo en la firma.
  const real = Buffer.byteLength(canonicalize(salida), 'utf8');
  if (real !== target) throw new Error(`quedó en ${real}, esperaba ${target}`);

  return salida;
}
```

Validado sobre 5.000 eventos con contenido variable (1 a 5 ítems, importes y
CNPJ distintos): cada uno midió exactamente el tamaño que le tocó.

## Perillas de carga

| Perilla | Efecto |
|---|---|
| `items_por_documento` | Rango `[min, max]`. **No cambia el peso**: cambia cuánto es contenido y cuánto relleno. Se **recorta solo** si no entra en el tamaño sorteado — una plantilla de 1,5 KB no admite 5 ítems y el generador baja a los que quepan en vez de fallar. |
| `tamano_bytes` | Rango `[min, max]` del tamaño canónico. Un escalar pide tamaño fijo. |
| `eventsPerThread` | Cuántos eventos comparten `rpf_id`. Con 1, un grupo por evento y paralelismo máximo. Con 50, orden estricto por expediente y te acercas al techo de 300 msg/s por grupo. **Es la perilla que ejercita D-06.** |

## El sobre

Lo que viaja en el cuerpo del mensaje SQS. **C3 y C4 dependen de este formato:
acordarlo antes de escribir código.**

```jsonc
{
  "v": 1,                      // versión del sobre
  "alg": "AES-256-GCM",
  "sig_alg": "Ed25519",
  "key_id": "arn:aws:kms:...", // llave de firma, para que C4 sepa cuál usar
  "edk": "base64",             // data key cifrada por KMS (encrypted data key)
  "iv":  "base64",             // 12 bytes
  "tag": "base64",             // 16 bytes, GCM auth tag
  "ct":  "base64"              // ciphertext de { payload, signature }
}
```

El plaintext que se cifra es:

```jsonc
{ "payload": { /* el documento canónico */ }, "signature": "base64" }
```

Atributos del mensaje SQS, **en claro**:

```
MessageGroupId            = rpf_id
MessageDeduplicationId    = payload_hash   // sha256 del canónico EN CLARO (paso ②)
MessageAttributes.prueba  = x-prueba-id    // el id de corrida (opcional)
```

Los dos primeros son de sistema: el cuerpo está cifrado, así que si viajaran
dentro la cola no tendría de dónde sacar ni el orden ni la deduplicación.

El tercero es el **id de corrida** cruzando el único canal que hay entre los dos
dominios — lo genera el orquestador y lo copia el relay de C3 desde
`outbox.prueba`. Sirve para que C4 separe sus métricas por prueba: sin él, dos
corridas seguidas caen en el mismo archivo. Va **fuera del payload** porque el
payload va firmado (regla 8) y porque el id de una prueba no pertenece a un
asiento fiscal.

### Tamaño en la cola

El payload canónico son 4.096 bytes en el peor caso. El sobre añade firma (64 B), IV, tag,
`edk` y el crecimiento de base64 (~33%). El mensaje resultante ronda los
**4,3 KB**. Sigue muy por debajo del límite de 256 KB.
