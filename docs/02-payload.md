# 02 — Payload y sobre

## Requisito

> **⚠ CAMBIO DE DISEÑO.** Dos cosas cambiaron respecto de la versión original
> de este documento:
>
> 1. **Quién genera**: ya no es C3, es el **orquestador**. Ver
>    [04-orquestador](04-orquestador.md).
> 2. **El tamaño ya no es fijo**: se sortea en un rango. El valor único de
>    3.072 bytes sigue siendo el **techo** y sigue siendo expresable
>    (`tamano_bytes: 3072`), pero el defecto es `[1536, 3072]`.

Cada evento pesa **exactamente el tamaño que le tocó** en su forma canónica. El
contenido es aleatorio y de largo variable; un campo `padding` absorbe la
diferencia.

| | |
|---|---|
| Tamaño canónico | sorteado en `[1536, 3072]`, exacto por evento |
| Techo de diseño | 3.072 bytes |
| **Piso real, medido** | **1.403 bytes** — el documento con 1 ítem |
| Esqueleto sin ítems | 1.240 bytes |
| Atributos hoja | ~52 |
| Margen al límite de SQS | 83× en el peor caso (256 KB) |

### Por qué 1 KB es imposible

El esqueleto del documento fiscal — los ~52 atributos hoja, sin un solo ítem —
pesa **1.240 bytes canónicos**. Con el ítem mínimo son **1.403**. Y un
documento fiscal sin ítems no existe.

Pedir plantillas de 1 KB obligaría a mutilar el documento, y **un documento
mutilado no compara con nada**: la firma, el cifrado y el tamaño en cola
dejarían de representar el caso real. El mínimo admisible es **1.411** (1.403 +
8 bytes de relleno reservado), y la config lo rechaza por debajo.

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
padding           string    relleno base64 para llegar a 3.072
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
const TARGET = 3072;
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
CNPJ distintos): los 5.000 midieron 3.072 bytes.

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
MessageGroupId          = rpf_id
MessageDeduplicationId  = payload_hash   // sha256 del canónico EN CLARO (paso ②)
```

### Tamaño en la cola

El payload canónico son 3.072 bytes. El sobre añade firma (64 B), IV, tag,
`edk` y el crecimiento de base64 (~33%). El mensaje resultante ronda los
**4,3 KB**. Sigue muy por debajo del límite de 256 KB.
