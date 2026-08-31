import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { bytesCanonicos, canonicalize } from '../src/comun/jcs';

test('ordena las claves por unidades de codigo UTF-16', () => {
  assert.equal(canonicalize({ b: 1, a: 2, A: 3 }), '{"A":3,"a":2,"b":1}');
});

test('los arrays conservan su orden', () => {
  assert.equal(canonicalize([3, 1, 2]), '[3,1,2]');
});

test('no escapa los no-ASCII', () => {
  assert.equal(canonicalize({ k: 'ção' }), '{"k":"ção"}');
});

test('mide en BYTES, no en caracteres (PL-02)', () => {
  // 'ção' son 3 caracteres pero 5 bytes: con .length el ajuste a tamano
  // saldria corto y el evento pesaria distinto de lo declarado. Dos bytes de
  // diferencia por evento, multiplicados por la corrida entera, es la
  // distancia entre "medimos MB/s" y "creimos medir MB/s".
  assert.equal(canonicalize({ k: 'ção' }).length, 11);
  assert.equal(bytesCanonicos({ k: 'ção' }), 13);
});

test('rechaza NaN, Infinity y tipos no serializables', () => {
  assert.throws(() => canonicalize({ a: NaN }), /no finito/);
  assert.throws(() => canonicalize({ a: Infinity }), /no finito/);
  assert.throws(() => canonicalize({ a: 1n }), /no serializable/);
});

test('omite undefined igual que JSON.stringify', () => {
  assert.equal(canonicalize({ a: undefined, b: 1 }), '{"b":1}');
});

test('null se serializa, no se omite', () => {
  assert.equal(canonicalize({ a: null }), '{"a":null}');
});

/**
 * ⚠ EL TEST QUE IMPORTA.
 *
 * `c4/src/comun/jcs.ts` y `orquestador/src/generador/jcs.ts` son la misma
 * implementacion duplicada. Si una deriva, el sintoma NO es "hay dos copias":
 * es que la firma deja de verificar y C4 manda todo a la DLQ con alarma —
 * indistinguible de un intento de inyeccion. Este test convierte esa deriva
 * silenciosa en un fallo ruidoso.
 */
test('el JCS de C4 no derivo del JCS del orquestador', () => {
  // Anclado al cwd (siempre c4/) y NO a __dirname: compilado, __dirname
  // apunta dentro de dist-test/ y las rutas relativas no resuelven. La
  // primera version de este test se SALTABA en silencio por eso — que es
  // exactamente la forma en que un guardia de deriva deja de guardar.
  const raiz = process.cwd();
  const ajeno = readFileSync(
    join(raiz, '..', 'orquestador', 'src', 'generador', 'jcs.ts'), 'utf8',
  );
  const mio = readFileSync(join(raiz, 'src', 'comun', 'jcs.ts'), 'utf8');
  assert.equal(codigo(mio), codigo(ajeno), 'las dos copias del JCS ya no son la misma');
});

/** El cuerpo, sin el comentario de cabecera ni espacios sueltos. */
function codigo(fuente: string): string {
  const i = fuente.indexOf('export function canonicalize');
  return fuente.slice(i).replace(/\s+/g, ' ').trim();
}
