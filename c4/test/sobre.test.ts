import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { canonicalize } from '../src/comun/jcs';
import { abrir, payloadHash, parsearSobre, sellar } from '../src/comun/sobre';

const clave = () => randomBytes(32);
const edk = Buffer.from('edk-de-mentira');
const KEY_ID = 'arn:aws:kms:us-west-2:1:key/abc';

const contenido = () => ({
  payload: { rpf_id: 'a', sequence: 1, totals: { total: '18450.00' } },
  signature: Buffer.from('firma').toString('base64'),
});

test('sellar y abrir devuelven el mismo contenido', () => {
  const k = clave();
  const s = sellar(contenido(), k, edk, KEY_ID);
  assert.deepEqual(abrir(s, k), contenido());
});

test('el sobre lleva la version, los algoritmos y la llave de FIRMA', () => {
  const s = sellar(contenido(), clave(), edk, KEY_ID);
  assert.equal(s.v, 1);
  assert.equal(s.alg, 'AES-256-GCM');
  assert.equal(s.sig_alg, 'Ed25519');
  // key_id es la llave de firma, no la de cifrado: es lo que C4 necesita para
  // saber con cual verificar.
  assert.equal(s.key_id, KEY_ID);
  assert.equal(Buffer.from(s.iv, 'base64').length, 12);
  assert.equal(Buffer.from(s.tag, 'base64').length, 16);
});

test('dos cifrados del MISMO contenido dan ciphertext distinto', () => {
  // Esta es la razon entera de D-11 y de la regla 5: con IV nuevo cada vez, la
  // dedup por contenido de SQS jamas veria dos mensajes iguales.
  const k = clave();
  const a = sellar(contenido(), k, edk, KEY_ID);
  const b = sellar(contenido(), k, edk, KEY_ID);
  assert.notEqual(a.ct, b.ct);
  assert.notEqual(a.iv, b.iv);
  // Y sin embargo el payload_hash, que se calcula sobre el CLARO, si coincide.
  assert.equal(payloadHash(contenido().payload), payloadHash(contenido().payload));
});

test('un ciphertext manipulado no abre', () => {
  const k = clave();
  const s = sellar(contenido(), k, edk, KEY_ID);
  const ct = Buffer.from(s.ct, 'base64');
  ct[5] = (ct[5] ?? 0) ^ 0xff;
  assert.throws(() => abrir({ ...s, ct: ct.toString('base64') }, k));
});

test('un tag manipulado no abre', () => {
  const k = clave();
  const s = sellar(contenido(), k, edk, KEY_ID);
  const tag = Buffer.from(s.tag, 'base64');
  tag[0] = (tag[0] ?? 0) ^ 0xff;
  assert.throws(() => abrir({ ...s, tag: tag.toString('base64') }, k));
});

test('con la llave equivocada no abre', () => {
  const s = sellar(contenido(), clave(), edk, KEY_ID);
  assert.throws(() => abrir(s, clave()));
});

test('payload_hash no depende del orden de las claves', () => {
  const a = { rpf_id: 'x', sequence: 2, party_id: 'hmac:00' };
  const b = { party_id: 'hmac:00', sequence: 2, rpf_id: 'x' };
  assert.equal(payloadHash(a), payloadHash(b));
  assert.equal(payloadHash(a).length, 64);
});

test('payload_hash cambia si cambia un solo importe', () => {
  const a = { totals: { total: '18450.00' } };
  const b = { totals: { total: '18450.01' } };
  assert.notEqual(payloadHash(a), payloadHash(b));
});

test('parsearSobre rechaza lo que no es un sobre', () => {
  assert.throws(() => parsearSobre('no soy json'), /no es JSON/);
  assert.throws(() => parsearSobre('{"hola":"mundo"}'), /faltan campos/);
  const bueno = sellar(contenido(), clave(), edk, KEY_ID);
  assert.throws(() => parsearSobre(JSON.stringify({ ...bueno, v: 2 })), /sobre v2/);
  assert.throws(() => parsearSobre(JSON.stringify({ ...bueno, alg: 'AES-128-GCM' })), /alg=/);
  assert.throws(() => parsearSobre(JSON.stringify({ ...bueno, sig_alg: 'RSA' })), /sig_alg=/);
  assert.deepEqual(parsearSobre(JSON.stringify(bueno)), bueno);
});

test('una data key que no mide 32 bytes se rechaza al sellar', () => {
  assert.throws(() => sellar(contenido(), randomBytes(16), edk, KEY_ID), /AES-256 pide 32/);
});

test('el plaintext cifrado esta canonizado', () => {
  // Importa para depurar: dado el mismo IV, el sobre es reproducible byte a
  // byte, y eso es lo que permite comparar dos ejecuciones cuando una firma
  // no verifica.
  const k = clave();
  const c = contenido();
  const s = sellar(c, k, edk, KEY_ID);
  const abierto = abrir(s, k);
  assert.equal(canonicalize(abierto), canonicalize(c));
});
