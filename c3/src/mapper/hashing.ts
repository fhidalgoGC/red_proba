/**
 * Paso ② del pipeline RPF · Hashing.
 *
 *   SHA-256      -> payload_hash
 *   HMAC-SHA256  -> party_id
 *
 * Son los dos artefactos que el protocolo produce entre canonizar (①) y
 * firmar (⑤), y los dos viajan en el receipt junto a `rpf_id` y la firma.
 *
 * Las dos mitades estan aqui juntas porque comparten una propiedad que no es
 * obvia y de la que depende todo lo demas: LAS DOS SE CALCULAN SOBRE EL
 * CANONICO, nunca sobre el objeto sin canonizar. Dos JSON con las mismas
 * claves en distinto orden son el mismo documento y tienen que dar el mismo
 * hash; si no, el `payload_hash` dejaria de identificar el documento y pasaria
 * a identificar una serializacion concreta de el.
 *
 * ⚠ POR QUE NO ESTAN EN EL MISMO ARCHIVO QUE EL RESTO DE LA CRIPTO: el
 * `party_id` necesita una llave y el `payload_hash` no. El primero vive en
 * `cripto/pseudonimo.service.ts`, que habla con KMS; aqui solo esta la parte
 * pura, la que se puede probar con vectores fijos.
 */
import { createHash } from 'node:crypto';

/**
 * `payload_hash` — SHA-256 del canonico EN CLARO, en hex.
 *
 * ⚠ SE RE-EXPORTA, NO SE REIMPLEMENTA. La implementacion vive en
 * `comun/sobre.ts` porque es el UNICO contrato entre C3 y C4: C3 lo calcula y
 * lo declara como `MessageDeduplicationId`, y C4 lo RECALCULA y compara. Dos
 * implementaciones que se separen dan `payload_hash_no_coincide` — que C4
 * trata como «o el emisor mintio o el JCS derivo», va a la DLQ con alarma, y
 * es indistinguible de un ataque.
 *
 * Tres papeles a la vez, y por eso importa que sea uno solo:
 *
 *  1. Identifica el documento dentro del protocolo RPF.
 *  2. Es el `MessageDeduplicationId` de SQS. En claro y no del ciphertext:
 *     AES-GCM usa un IV distinto en cada operacion, asi que el mismo evento
 *     cifrado dos veces da bytes distintos y un hash del sobre no detectaria
 *     nunca un duplicado (D-11, regla 5).
 *  3. Es la clave primaria del inbox de C4. La misma llave a los dos lados es
 *     lo que permite conciliar outbox contra inbox, que es como se responde
 *     P4.
 */
export { payloadHash } from '../comun/sobre';

/**
 * `party_id` local — HMAC-SHA256 con una llave del proceso.
 *
 * ⚠ SOLO PARA CORRER SIN KMS. En cualquier despliegue real el HMAC lo hace
 * `KMS GenerateMac` sobre `KMS_HMAC_KEY_ID`, y la llave no sale nunca del
 * dominio del participante (D-08). Esta version existe para que los tests no
 * necesiten credenciales; lo que produce no lo acepta ningun C4 real.
 *
 * Se deriva del propio identificador para que sea reproducible entre
 * arranques: si cambiara, el mismo documento daria dos `payload_hash`
 * distintos y C4 lo contaria dos veces.
 */
export function partyIdLocal(tenantId: string): string {
  return createHash('sha256').update(`c3-local:${tenantId}`, 'utf8').digest('hex');
}
