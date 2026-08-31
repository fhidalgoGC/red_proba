import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { bytesCanonicos, canonicalize } from '../src/generador/jcs';

/**
 * Vectores fijos del canonicalizador, ANTES que cualquier otra cosa.
 *
 * Es la misma exigencia que C-02 le pone a C3, y por la misma razon: el
 * orquestador ajusta el tamaño con este JCS y C3 firma con el suyo. Si
 * divergen, el sintoma aparece lejos de la causa — como una firma que no
 * verifica — y cuesta horas encontrarlo.
 */

test('ordena las claves por unidades de codigo UTF-16', () => {
  assert.equal(canonicalize({ b: 1, a: 2, C: 3 }), '{"C":3,"a":2,"b":1}');
  // Mayusculas antes que minusculas: es orden de code unit, no alfabetico.
  assert.equal(canonicalize({ a: 1, B: 2 }), '{"B":2,"a":1}');
});

test('no reordena arreglos', () => {
  assert.equal(canonicalize([3, 1, 2]), '[3,1,2]');
});

test('ordena claves anidadas', () => {
  assert.equal(
    canonicalize({ z: { b: 1, a: 2 }, a: [{ y: 1, x: 2 }] }),
    '{"a":[{"x":2,"y":1}],"z":{"a":2,"b":1}}',
  );
});

test('escapa como manda RFC 8785 y deja pasar el no-ASCII', () => {
  assert.equal(canonicalize('a\nb'), '"a\\nb"');
  assert.equal(canonicalize('a\u0001b'), '"a\\u0001b"');   // hex minuscula
  assert.equal(canonicalize('"\\'), '"\\"\\\\"');
  assert.equal(canonicalize('ação'), '"ação"');            // sin escapar
});

test('rechaza lo que no tiene representacion canonica', () => {
  assert.throws(() => canonicalize(NaN), /no finito/);
  assert.throws(() => canonicalize(Infinity), /no finito/);
  assert.throws(() => canonicalize(() => 1), /no serializable/);
});

test('mide en BYTES, no en caracteres', () => {
  // 'ção' son 3 caracteres pero 5 bytes en UTF-8.
  const s = canonicalize('ção');
  assert.equal(s.length, 5);              // "ção" con comillas
  assert.equal(bytesCanonicos('ção'), 7); // 5 bytes de contenido + 2 comillas
});

test('el orden del objeto de entrada no cambia la salida', () => {
  const a = { rpf_id: 'x', event_id: 'y', totals: { icms: '1.00', ipi: '2.00' } };
  const b = { totals: { ipi: '2.00', icms: '1.00' }, event_id: 'y', rpf_id: 'x' };
  assert.equal(canonicalize(a), canonicalize(b));
});
