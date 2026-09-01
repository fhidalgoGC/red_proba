# 02 · Criptografía

Dos operaciones, y ninguna de las dos es la que se supone a primera vista.

| | Lo que parece | Lo que es |
|---|---|---|
| Descifrar | KMS descifra el documento | KMS descifra **una llave de 32 bytes**; el documento lo abre C4 en local |
| Verificar | KMS verifica la firma | C4 verifica **en proceso**, con una clave pública cacheada. KMS no participa |

---

## Cifrado en sobre: KMS descifra la llave, no el payload

Lo que viaja en el cuerpo del mensaje SQS es el **sobre**
([02-payload](../../docs/02-payload.md#el-sobre)):

```jsonc
{
  "v": 1, "alg": "AES-256-GCM", "sig_alg": "Ed25519",
  "key_id": "arn:aws:kms:...",  // la llave de FIRMA, no la de cifrado
  "edk": "base64",              // la data key, cifrada por KMS
  "iv": "base64", "tag": "base64",
  "ct": "base64"                // { payload, signature }, cifrado
}
```

C4 hace:

```
KMS Decrypt(sobre.edk)              →  data key de 32 bytes
AES-256-GCM(ct, iv, tag, data key)  →  { payload, signature }   ← local
```

**Por qué importa que sea así y no que KMS descifre el documento:**

- El payload **nunca sale de C4**. Mandar 3 KB a KMS por evento sería tráfico
  gratuito, y además `Decrypt` tiene un techo de 4 KB.
- Como C3 reusa una data key por lote (C-04), **C4 la cachea por `edk`**. En la
  corrida de prueba fueron **1 `Decrypt` para 17 mensajes**.

> Sin ese caché, C4 gastaría un `Decrypt` por mensaje para obtener N veces la
> misma llave. La llamada ronda los 20-40 ms: el tramo `e7b→e8` mediría la
> latencia de KMS en vez del descifrado, y el consumidor se toparía antes con
> la cuota de KMS que con la de la cola. **P3 respondería "el límite es KMS"
> por un motivo que es de implementación, no de arquitectura.**

El caché es un `Map` con desalojo por uso reciente, tope 64 entradas. Las data
keys en claro se rellenan con ceros al desalojar y al cerrar: se van con el
proceso igual, pero borrarlas a mano deja dicho que son material sensible.

### `KMS_ENCRYPT_KEY_ID` es explícito aunque la policy ya lo limite

`Decrypt` acepta el `KeyId` como opcional: sin él, KMS descifra con la llave que
diga el propio blob. La policy de C4 ya solo permite una llave, así que un blob
ajeno daría `AccessDenied` igual — pero **`AccessDenied` no distingue «no tengo
permiso» de «esto no es mío»**. Pasarlo explícito convierte un error ambiguo en
uno que dice qué pasó.

---

## La firma se verifica en local

KMS **sí** soporta Ed25519 de verdad. Confirmado contra la llave de la PoC:

```
KeySpec             ECC_NIST_EDWARDS25519
SigningAlgorithms   ED25519_SHA_512, ED25519_PH_SHA_512
firma               64 bytes, raw
```

C3 firma con `ED25519_SHA_512` y `MessageType: RAW`. C4 baja la clave pública
una vez con `GetPublicKey` —que devuelve SPKI en DER—, la importa con
`createPublicKey({ format: 'der', type: 'spki' })` y verifica con
`verify(null, canonico, publica, firma)`. El `null` es Ed25519 puro: el hash va
dentro del esquema, no se pasa aparte.

**Las dos razones, y la segunda es la que importa:**

1. `Verify` sería una llamada de red por evento (~30 ms) contra una cuota que
   comparten los 50 tenants. C4 se saturaría en KMS antes que en cualquier
   componente que la PoC quiere medir.
2. **La clave pública es pública.** Bajarla una vez y verificar en proceso da
   exactamente la misma garantía criptográfica, y deja escrito en el código que
   C4 solo necesita `GetPublicKey` — **nunca `Sign`**. El invariante de la
   regla 7 pasa de vivir solo en la policy de KMS a ser visible en el código.

> **Techo a vigilar:** `Sign` con `MessageType: RAW` no acepta más de 4.096
> bytes. El techo del payload son 3.072 ([02-payload](../../docs/02-payload.md)),
> así que entra. Si alguien sube ese techo, KMS respondería
> `ValidationException` sin decir por qué; hay un chequeo explícito que lo
> nombra y apunta a `ED25519_PH_SHA_512` como salida.

---

## ⚠ `C4_LLAVES_FIRMA`: la lista blanca no es configuración, es seguridad

`key_id` viaja **dentro del sobre, en claro, y lo escribió quien publicó**.

Si C4 fuera a buscar la llave que el propio mensaje pide, cualquiera con
permiso de publicar en la cola podría firmar con **su** llave, poner su ARN en
`key_id`, y la firma verificaría perfectamente. Sería verificar que el mensaje
se firmó a sí mismo.

```
sin lista blanca  →  la firma prueba INTEGRIDAD
con lista blanca  →  la firma prueba AUTORÍA
```

Por eso la comprobación va **antes** de mirar la firma y antes de pedir la
clave: un `key_id` que no está en la lista no merece ni una llamada a KMS.

El proceso arranca sin ella —no queremos que una PoC no levante por esto— pero
grita en el log al hacerlo.

---

## Se firma primero y se cifra después

La firma viaja **dentro** del ciphertext, junto al payload:

```
plaintext cifrado  =  { "payload": {...}, "signature": "base64" }
```

Es la regla 6. La firma cubre el documento, no un cifrado que cualquiera con la
llave simétrica pudo rehacer. La consecuencia para C4 es el orden obligado del
[camino de un mensaje](01-como-funciona.md#el-camino-de-un-mensaje): **no se
puede verificar lo que todavía no se puede leer**.

Y al verificar, C4 **recanoniza el payload que va a guardar** en vez de confiar
en unos bytes que vinieran en el sobre. Firmar sobre lo que el emisor *dice*
que canonizó dejaría un hueco por el que lo persistido podría no ser lo
firmado. El punta a punta lo comprueba: `el payload guardado es byte a byte el
firmado, 12/12`.

---

## El invariante, en una línea

**C4 descifra pero nunca firma. C3 firma y cifra pero nunca descifra.**

No lo sostiene este código: lo sostienen las policies de KMS. Lo que el código
hace es no tener siquiera la mitad que no le toca — el servicio de descifrado
de C4 no importa `SignCommand`, y ninguna ruta puede alcanzarlo.

`terraform/oneClient` publica los comandos que lo prueban asumiendo el rol de
C4:

```
kms sign        --key-id <firma_c3>   DEBE dar AccessDenied
kms get-public-key --key-id <firma_c3>   DEBE funcionar
```


---

## Medido · la caché de data keys en cifras

C3 pide una data key cada 100 eventos (`C3_EVENTOS_POR_DATA_KEY`) y la reutiliza,
así que sin caché C4 gastaría un `Decrypt` **por mensaje** para obtener N veces
la misma clave. Con la caché es uno por lote.

En la corrida de 468 678 documentos eso fueron **~4 687 llamadas a `Decrypt`**
en vez de 468 678 — un factor 100. En coste, $0,014 en vez de $1,41; en
latencia, lo que se ahorró es más: cada llamada a KMS ronda los 20-40 ms y el
tramo `e7→e8` completo salió en **1 ms** de mediana.

⚠ La caché tiene tope (`MAX_CACHE = 64`). Con 39 tenants rotando claves de forma
independiente cabe de sobra; a 200 tenants habría que revisarlo, porque una
caché que expulsa entradas antes de reusarlas es una caché que no sirve para
nada y solo añade una indirección.
