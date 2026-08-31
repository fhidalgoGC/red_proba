# 03 · Criptografía

Tres operaciones con llave, y **KMS hace menos de lo que la gente supone**.

```
HMAC-SHA256   GenerateMac        1 llamada AL ARRANCAR, cacheada de por vida
firma         Sign               1 llamada POR EVENTO  ← el cuello de botella
data key      GenerateDataKey    1 llamada CADA 100 EVENTOS
cifrado       AES-256-GCM        en proceso, 0 red
```

---

## `party_id` — una llamada, no dos mil por segundo

Es `HMAC(TENANT_ID)` con `KMS_HMAC_KEY_ID`, y **el `tenant_id` de un contenedor
no cambia**. Pedírselo a KMS por evento serían 2.000 llamadas por segundo a una
cuota que la firma necesita entera, para obtener siempre el mismo string.

Se calcula en `onModuleInit` y se cachea de por vida del proceso.

`HMAC_SHA_256` devuelve 32 bytes = 64 hex, y **va completo**. Antes se truncaba
a la mitad; truncar no lo rompía —128 bits siguen siendo suficientes para un
seudónimo— pero lo apartaba del protocolo RPF.

La llave vive en el KMS de C3 y **nunca sale del dominio del participante**:
C4 agrupa por `party_id` sin poder saber a qué tenant corresponde (D-08).

> Detalle completo en
> [../../docs/09-party-id-y-payload-hash.md](../../docs/09-party-id-y-payload-hash.md).

---

## La firma — el cuello de botella, y por eso hay tanto cuidado

```ts
SigningAlgorithm: 'ED25519_SHA_512'
MessageType:      'RAW'
```

**No existe `EDDSA` en el SDK.** Y la variante `ED25519_PH_SHA_512` pide
`DIGEST` y produce firmas que la verificación Ed25519 pura de C4 **rechazaría**
— mismo nombre de curva, esquema distinto. Es el error que más silenciosamente
habría roto todo.

Se firma **el canónico**, no un hash del canónico: Ed25519 puro hace el SHA-512
por dentro. C4 verifica con `verify(null, canonico, pub, firma)`, que es la
misma convención.

Todo lo demás está puesto para que lo que se mida sea KMS y no una torpeza:

- **cliente del SDK en singleton** — uno por petición añadiría el handshake TLS
  a cada evento;
- **sin reintento propio** — el SDK ya reintenta lo reintentable, y un
  reintento a mano falsearía el tramo `e1→e2` sumando esperas que no son de la
  firma.

**Medido**: 83 ms de media, p50 66 ms, p99 715 ms. Es el 92% del tiempo de C3.

---

## El cifrado — una data key cada 100 eventos

`GenerateDataKey` sobre la **llave simétrica de C4**. C3 puede pedirla pero no
puede descifrar nada con ella: es el otro lado de la regla 7.

Una llamada por lote, no por evento. `GenerateDataKey` es simétrica y aguanta
mucho más que la firma, pero pedirla por evento duplicaría el tráfico a KMS sin
comprar nada — la misma data key cifra N sobres **con un IV distinto cada uno**,
y ahí es donde está la seguridad. Del otro lado C4 cachea por `edk`, así que
reusarla también le ahorra a él un `Decrypt` por mensaje.

La renovación se **comparte entre peticiones concurrentes**: sin eso, N
requests que llegan con la data key agotada disparan N `GenerateDataKey` a la
vez, justo bajo la ráfaga.

---

## El sobre

```jsonc
{ "v": 1, "alg": "AES-256-GCM", "sig_alg": "Ed25519",
  "key_id": "arn:aws:kms:…",   // llave de FIRMA, para que C4 sepa cuál usar
  "edk": "base64",             // data key cifrada
  "iv": "base64", "tag": "base64",
  "ct": "base64" }             // ciphertext de { payload, signature }
```

`sellar()` y `abrir()` viven en `comun/sobre.ts`, **el mismo archivo en C3 y en
C4**. Es el único contrato entre dos dominios que no se ven: si el formato se
definiera dos veces, la primera vez que divergieran el síntoma sería «no
descifra», indistinguible de un intento de inyección.

Ese archivo **no llama a KMS a propósito**. Si `abrir()` supiera pedirle la data
key a KMS, C4 podría importar el mismo helper que C3 y el invariante de la
regla 7 dejaría de estar sostenido por las policies.

**Medido**: 3.072 bytes canónicos → 4.708 de sobre (×1,53). El límite de SQS
son 256 KB: hay 54× de margen.

---

## Las tres copias del JCS

`jcs.ts` existe **tres veces**: en el orquestador, en C3 y en C4. El orquestador
ajusta el tamaño con JCS, C3 firma sobre JCS y C4 verifica sobre JCS.

Si una deriva, el síntoma **no es** «hay tres implementaciones»: es «la firma no
verifica», que C4 no puede distinguir de un ataque y manda a la DLQ con alarma.

Por eso hay un test en cada servicio que **compara los fuentes** de las tres
copias. Comparar salidas solo detecta las divergencias que a uno se le ocurrió
probar; comparar el código las detecta todas.

---

## El modo local

Sin las tres llaves de KMS, C3 firma con una Ed25519 del proceso y cifra con una
data key local. **Las tres o ninguna** — a medias firmaría con KMS y cifraría en
local, y el fallo aparecería recién en C4 como «no descifra».

Sirve para correr los tests sin credenciales, **y para nada más**: C4 no puede
abrir lo que produce. La `edk` no viene de `GenerateDataKey` y la llave no está
en su lista blanca. Los dos casos terminan en la DLQ con alarma.

```bash
npm run start:local
```

Y por eso existe `npm run e2e:kms`: es la **única** prueba que responde si lo
que cifra C3 lo puede abrir C4, porque corre contra KMS y la cola reales.
