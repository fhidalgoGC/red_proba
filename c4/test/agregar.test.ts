/**
 * La pre-agregacion del INSERT multifila.
 *
 * ⚠ ESTOS FALLOS NO DAN EXCEPCION. Un error aqui no rompe nada: da contadores
 * que no cuadran —`eventos` de menos en key_registry, un expediente contado
 * dos veces en shared_map— y eso se descubre semanas despues comparando dos
 * informes que deberian coincidir.
 *
 * La unica excepcion que si es ruidosa es la que estas funciones existen para
 * evitar: `ON CONFLICT DO UPDATE command cannot affect row a second time`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  agregarCaseHeader,
  agregarKey,
  agregarPolicy,
  agregarSharedMap,
  marcadores,
  marcadoresTipados,
  type FilaProyectable,
} from '../src/bd/agregar';

const fila = (p: Partial<FilaProyectable> = {}): FilaProyectable => ({
  rpfId: 'exp-1',
  sequence: 1,
  partyId: 'hmac:aa',
  keyId: 'arn:kms:llave-1',
  sigAlg: 'ED25519_SHA_512',
  eventType: 'invoice.issued',
  schemaVersion: '1.0',
  occurredAt: '2026-08-31T12:00:00.000Z',
  accessKey: null,
  totalProducts: null,
  contraparteCnpj: '11222333000181',
  contraparteUf: 'SP',
  ...p,
});

// ── key_registry — la que obliga a todo esto ────────────────────────────────

test('key_registry funde la llave compartida por todo el lote en UNA fila', () => {
  // El caso real: diez mensajes, una sola llave de firma. Sin fundir serian
  // diez filas con la misma clave y Postgres rechazaria la sentencia entera.
  const lote = Array.from({ length: 10 }, (_, i) => fila({ rpfId: `exp-${i}` }));
  const r = agregarKey(lote);

  assert.equal(r.length, 1, 'diez filas con la misma llave habrian reventado el multifila');
  assert.equal(r[0]!.eventos, 10, 'el contador tiene que traer el total del lote, no 1');
  assert.equal(r[0]!.keyId, 'arn:kms:llave-1');
});

test('key_registry separa llaves distintas', () => {
  const r = agregarKey([fila(), fila({ keyId: 'arn:kms:llave-2' }), fila()]);
  assert.equal(r.length, 2);
  assert.deepEqual(
    r.map((x) => [x.keyId, x.eventos]),
    [['arn:kms:llave-1', 2], ['arn:kms:llave-2', 1]],
  );
});

// ── policy_registry ─────────────────────────────────────────────────────────

test('policy_registry agrupa por tipo Y version, no solo por tipo', () => {
  const r = agregarPolicy([
    fila(),
    fila({ schemaVersion: '2.0' }),
    fila(),
    fila({ eventType: 'invoice.cancelled' }),
  ]);
  assert.equal(r.length, 3);
  const total = r.reduce((s, x) => s + x.eventos, 0);
  assert.equal(total, 4, 'se perdio o se duplico algun evento al agrupar');
});

test('policy_registry ignora las filas sin tipo o sin version', () => {
  // La version por evento tenia un `if (eventType && schemaVersion)`; omitirlo
  // aqui insertaria filas con clave nula.
  const r = agregarPolicy([fila({ eventType: null }), fila({ schemaVersion: null }), fila()]);
  assert.equal(r.length, 1);
  assert.equal(r[0]!.eventos, 1);
});

// ── case_header ─────────────────────────────────────────────────────────────

test('case_header suma los eventos del expediente y guarda el rango de sequence', () => {
  const r = agregarCaseHeader([
    fila({ rpfId: 'exp-7', sequence: 2, occurredAt: '2026-08-31T12:00:02.000Z' }),
    fila({ rpfId: 'exp-7', sequence: 5, occurredAt: '2026-08-31T12:00:05.000Z' }),
    fila({ rpfId: 'exp-7', sequence: 1, occurredAt: '2026-08-31T12:00:01.000Z' }),
  ]);

  assert.equal(r.length, 1);
  const h = r[0]!;
  assert.equal(h.eventos, 3);
  assert.equal(h.sequenceMin, 1);
  assert.equal(h.sequenceMax, 5);
  assert.equal(h.primerEvento, '2026-08-31T12:00:01.000Z');
  assert.equal(h.ultimoEvento, '2026-08-31T12:00:05.000Z');
});

test('case_header toma el tipo del sequence MAS ALTO, no del ultimo leido', () => {
  // Llegan desordenados a proposito: el 5 se lee antes que el 2. Si se tomara
  // "el ultimo visto", el estado del expediente quedaria en el tipo del 2.
  const r = agregarCaseHeader([
    fila({ rpfId: 'exp-7', sequence: 5, eventType: 'invoice.cancelled' }),
    fila({ rpfId: 'exp-7', sequence: 2, eventType: 'invoice.issued' }),
  ]);
  assert.equal(r[0]!.ultimoTipo, 'invoice.cancelled');
  assert.equal(r[0]!.sequenceMax, 5);
});

test('case_header conserva el primer valor no nulo de los campos opcionales', () => {
  const r = agregarCaseHeader([
    fila({ rpfId: 'exp-7', sequence: 1, accessKey: null, totalProducts: null }),
    fila({ rpfId: 'exp-7', sequence: 2, accessKey: '4432', totalProducts: '9' }),
  ]);
  assert.equal(r[0]!.accessKey, '4432', 'el COALESCE del lado de JS no rellena el nulo');
  assert.equal(r[0]!.totalProducts, '9');
});

test('case_header no mezcla expedientes distintos', () => {
  const r = agregarCaseHeader([
    fila({ rpfId: 'exp-1' }),
    fila({ rpfId: 'exp-2' }),
    fila({ rpfId: 'exp-1' }),
  ]);
  assert.equal(r.length, 2);
  assert.equal(r.find((x) => x.rpfId === 'exp-1')!.eventos, 2);
  assert.equal(r.find((x) => x.rpfId === 'exp-2')!.eventos, 1);
});

// ── shared_map ──────────────────────────────────────────────────────────────

test('shared_map cuenta como expediente SOLO el evento que lo abre', () => {
  // Tres eventos del mismo par participante/contraparte, uno solo con
  // sequence 1. `expedientes` tiene que valer 1, no 3: si contara todos seria
  // una copia de `eventos` y no significaria nada.
  const r = agregarSharedMap([
    fila({ sequence: 1 }),
    fila({ sequence: 2 }),
    fila({ sequence: 3 }),
  ]);
  assert.equal(r.length, 1);
  assert.equal(r[0]!.eventos, 3);
  assert.equal(r[0]!.expedientes, 1);
});

test('shared_map no colisiona dos pares distintos que concatenan igual', () => {
  // "ab"+"c" contra "a"+"bc": sin separador en la clave, las dos entradas
  // caerian en la misma fila y una contraparte se comeria a la otra.
  const r = agregarSharedMap([
    fila({ partyId: 'ab', contraparteCnpj: 'c' }),
    fila({ partyId: 'a', contraparteCnpj: 'bc' }),
  ]);
  assert.equal(r.length, 2);
});

test('shared_map omite las filas sin participante o sin contraparte', () => {
  const r = agregarSharedMap([
    fila({ partyId: null }),
    fila({ contraparteCnpj: null }),
    fila(),
  ]);
  assert.equal(r.length, 1);
});

// ── marcadores ──────────────────────────────────────────────────────────────

test('los marcadores numeran sin saltos ni repeticiones', () => {
  assert.equal(marcadores(1, 3), '($1,$2,$3)');
  assert.equal(marcadores(3, 2), '($1,$2),($3,$4),($5,$6)');
});

test('los marcadores de un lote de 10 x 19 columnas llegan justo a 190', () => {
  // El tamaño real de un lote de inbox. Un desfase aqui da "bind message
  // supplies N parameters, but prepared statement requires M", que no dice
  // cual sobra.
  const m = marcadores(10, 19);
  assert.ok(m.endsWith('$190)'), `el ultimo marcador no es $190: ${m.slice(-24)}`);
  assert.equal(m.split('),(').length, 10);
});

test('cero filas no produce marcadores', () => {
  assert.equal(marcadores(0, 5), '');
});

test('los marcadores tipados castean solo la primera fila y siguen numerando bien', () => {
  // Sin el cast, un NULL en la primera fila da "could not determine data type
  // of parameter". Repetirlo en todas seria correcto pero ilegible.
  assert.equal(
    marcadoresTipados(3, ['uuid', 'int']),
    '($1::uuid,$2::int),($3,$4),($5,$6)',
  );
  assert.equal(marcadoresTipados(1, ['text']), '($1::text)');
  assert.equal(marcadoresTipados(0, ['text']), '');
});

test('los marcadores tipados de 10 filas x 10 columnas terminan en $100', () => {
  // El renumerado del resto es donde se rompe: si se olvidara el desplazamiento
  // por la primera fila, la segunda volveria a empezar en $1 y Postgres
  // reutilizaria los valores equivocados SIN dar error.
  const m = marcadoresTipados(10, Array(10).fill('text'));
  assert.ok(m.endsWith('$100)'), `no termina en $100: ${m.slice(-20)}`);
  assert.ok(m.includes('$11,$12'), 'la segunda fila no arranca en $11');
});
