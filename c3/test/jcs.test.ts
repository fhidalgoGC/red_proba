/**
 * El JCS de C3, y sobre todo: que no se haya separado de los otros dos.
 *
 * Hay TRES copias de este archivo — orquestador, C3 y C4 — y las tres tienen
 * que producir el mismo byte. El orquestador ajusta el tamano canonico con
 * JCS, C3 firma sobre JCS y C4 verifica sobre JCS. Si una deriva, el sintoma
 * no es «hay tres implementaciones»: es «la firma no verifica», que C4 no
 * puede distinguir de un intento de inyeccion y manda a la DLQ con alarma.
 *
 * Este test compara los FUENTES, no la salida. Comparar salidas solo detecta
 * las divergencias que a uno se le ocurrio probar; comparar el codigo detecta
 * todas, incluida la que alguien introduzca manana.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { bytesCanonicos, canonicalize } from '../src/comun/jcs';

// Desde el cwd: `npm test` corre en c3/, asi que la raiz del repo es su padre.
const C3 = process.cwd();
const RAIZ = join(C3, '..');

/** El cuerpo ejecutable, sin comentarios: cada copia explica su propio lado. */
function cuerpo(ruta: string): string {
  return readFileSync(ruta, 'utf8')
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return t !== '' && !t.startsWith('*') && !t.startsWith('/*') && !t.startsWith('//');
    })
    .join('\n');
}

test('el JCS de C3 no derivo del de C4 ni del del orquestador', () => {
  const mio = cuerpo(join(C3, 'src', 'comun', 'jcs.ts'));
  assert.equal(mio, cuerpo(join(RAIZ, 'c4', 'src', 'comun', 'jcs.ts')), 'C3 y C4 divergen');
  assert.equal(
    mio,
    cuerpo(join(RAIZ, 'orquestador', 'src', 'generador', 'jcs.ts')),
    'C3 y el orquestador divergen: el tamano ajustado alla no seria el firmado aca',
  );
});

test('el sobre de C3 no derivo del de C4', () => {
  // Este importa aun mas que el JCS: `sellar` y `abrir` son las dos mitades
  // de la misma operacion, en dominios que no se ven entre si.
  assert.equal(
    cuerpo(join(C3, 'src', 'comun', 'sobre.ts')),
    cuerpo(join(RAIZ, 'c4', 'src', 'comun', 'sobre.ts')),
    'C3 sella y C4 abre: si divergen, el sintoma es «no descifra»',
  );
});

test('ordena las claves por unidades de codigo UTF-16', () => {
  assert.equal(canonicalize({ b: 1, a: 2, C: 3 }), '{"C":3,"a":2,"b":1}');
});

test('los arrays conservan su orden', () => {
  // `items` es una lista de lineas numeradas: reordenarla cambiaria el
  // documento, no solo su representacion.
  assert.equal(canonicalize([3, 1, 2]), '[3,1,2]');
});

test('mide en BYTES, no en caracteres (regla 10)', () => {
  assert.equal(bytesCanonicos({ a: 'ç' }), Buffer.byteLength('{"a":"ç"}', 'utf8'));
  assert.notEqual(bytesCanonicos({ a: 'ç' }), '{"a":"ç"}'.length);
});

test('rechaza lo que no tiene canonico', () => {
  assert.throws(() => canonicalize({ a: NaN }));
  assert.throws(() => canonicalize({ a: Infinity }));
  assert.throws(() => canonicalize({ a: 1n }));
});
