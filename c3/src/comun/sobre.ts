import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { canonicalize } from './jcs';

/**
 * El SOBRE — lo que viaja en el cuerpo del mensaje SQS (02-payload).
 *
 * Vive aca, y no en C3 ni en C4, porque es el unico contrato entre los dos
 * dominios. No hay red entre ellos (D-03): si el formato se define dos veces,
 * la primera vez que divergen el sintoma es "no descifra", que es
 * indistinguible de un intento de inyeccion. Un solo archivo, dos lectores.
 *
 * ⚠ Lo que este archivo NO hace, a proposito: no llama a KMS. Las tres
 * operaciones con llave -Sign, GenerateDataKey, Decrypt- se quedan en el lado
 * que tiene permiso para hacerlas. Si `abrir()` supiera pedirle la data key a
 * KMS, C4 podria importar el mismo helper que C3 y el invariante de la regla 7
 * dejaria de estar sostenido por las policies para pasar a depender de que
 * nadie llame a la funcion equivocada.
 */

export const SOBRE_VERSION = 1;
export const ALG_CIFRADO = 'AES-256-GCM';
export const ALG_FIRMA = 'Ed25519';

/** 12 bytes: el tamano nativo de GCM. Con otro, node hace un GHASH extra. */
export const IV_BYTES = 12;
export const TAG_BYTES = 16;

export interface Sobre {
  v: number;
  alg: string;
  sig_alg: string;
  /** ARN de la llave de FIRMA, para que C4 sepa con cual verificar. */
  key_id: string;
  /** Data key cifrada por KMS. */
  edk: string;
  iv: string;
  tag: string;
  /** Ciphertext de `{ payload, signature }`. */
  ct: string;
}

/** El plaintext que se cifra. La firma viaja DENTRO, cifrada con el payload. */
export interface Contenido {
  payload: Record<string, unknown>;
  signature: string;
}

/**
 * `payload_hash` — sha256 del canonico EN CLARO.
 *
 * En claro y no del ciphertext: AES-GCM usa un IV distinto en cada operacion,
 * asi que el mismo evento cifrado dos veces da bytes distintos. Un hash del
 * sobre no detectaria nunca un duplicado (D-11, regla 5). Es a la vez el
 * MessageDeduplicationId de SQS y la clave primaria del inbox de C4: la misma
 * llave a los dos lados es lo que permite conciliar outbox contra inbox.
 */
export function payloadHash(payload: unknown): string {
  return createHash('sha256').update(canonicalize(payload), 'utf8').digest('hex');
}

/**
 * Cifra `{ payload, signature }` con una data key ya obtenida. Lado C3.
 *
 * La data key entra en claro porque quien llama acaba de recibirla de
 * `GenerateDataKey`, que devuelve las dos versiones -clara y cifrada- en la
 * misma respuesta.
 */
export function sellar(
  contenido: Contenido,
  dataKey: Buffer,
  edk: Buffer,
  keyIdFirma: string,
): Sobre {
  if (dataKey.length !== 32) {
    throw new Error(`la data key mide ${dataKey.length} bytes, AES-256 pide 32`);
  }

  const iv = randomBytes(IV_BYTES);
  const cifrador = createCipheriv('aes-256-gcm', dataKey, iv);

  // El plaintext se canoniza tambien. No hace falta para descifrar, pero
  // hace que el sobre sea reproducible byte a byte dado el mismo IV, que es
  // lo que permite depurar una firma que no verifica.
  const claro = Buffer.from(canonicalize(contenido), 'utf8');
  const ct = Buffer.concat([cifrador.update(claro), cifrador.final()]);

  return {
    v: SOBRE_VERSION,
    alg: ALG_CIFRADO,
    sig_alg: ALG_FIRMA,
    key_id: keyIdFirma,
    edk: edk.toString('base64'),
    iv: iv.toString('base64'),
    tag: cifrador.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  };
}

/**
 * Descifra el sobre con una data key ya descifrada. Lado C4.
 *
 * Lanza si el tag de GCM no cuadra: eso NO es corrupcion en transito -SQS
 * tiene su propia integridad- sino manipulacion o llave equivocada, y es uno
 * de los dos casos que G-07 manda a la DLQ con alarma.
 */
export function abrir(sobre: Sobre, dataKey: Buffer): Contenido {
  const iv = Buffer.from(sobre.iv, 'base64');
  const tag = Buffer.from(sobre.tag, 'base64');
  if (iv.length !== IV_BYTES) throw new Error(`iv de ${iv.length} bytes, esperaba ${IV_BYTES}`);
  if (tag.length !== TAG_BYTES) throw new Error(`tag de ${tag.length} bytes, esperaba ${TAG_BYTES}`);

  const descifrador = createDecipheriv('aes-256-gcm', dataKey, iv);
  descifrador.setAuthTag(tag);
  const claro = Buffer.concat([
    descifrador.update(Buffer.from(sobre.ct, 'base64')),
    descifrador.final(), // aca revienta si el tag no cuadra
  ]);

  const contenido = JSON.parse(claro.toString('utf8')) as Contenido;
  if (typeof contenido?.signature !== 'string' || typeof contenido?.payload !== 'object') {
    throw new Error('el plaintext no tiene la forma { payload, signature }');
  }
  return contenido;
}

/**
 * Valida la ENVOLTURA, sin abrirla. C4 lo llama antes de gastar una llamada a
 * KMS: un cuerpo que no es un sobre no merece un `Decrypt`, y distinguir
 * "esto no es mio" de "esto no descifra" es lo que separa un error de
 * configuracion de una posible inyeccion.
 */
export function parsearSobre(cuerpo: string): Sobre {
  let bruto: unknown;
  try {
    bruto = JSON.parse(cuerpo);
  } catch {
    throw new Error('el cuerpo del mensaje no es JSON');
  }

  const s = bruto as Partial<Sobre>;
  const falta = (['key_id', 'edk', 'iv', 'tag', 'ct'] as const).filter(
    (c) => typeof s[c] !== 'string' || s[c] === '',
  );
  if (falta.length > 0) throw new Error(`al sobre le faltan campos: ${falta.join(', ')}`);

  if (s.v !== SOBRE_VERSION) throw new Error(`sobre v${String(s.v)}, este C4 lee v${SOBRE_VERSION}`);
  if (s.alg !== ALG_CIFRADO) throw new Error(`alg=${String(s.alg)}, esperaba ${ALG_CIFRADO}`);
  if (s.sig_alg !== ALG_FIRMA) throw new Error(`sig_alg=${String(s.sig_alg)}, esperaba ${ALG_FIRMA}`);

  return s as Sobre;
}
