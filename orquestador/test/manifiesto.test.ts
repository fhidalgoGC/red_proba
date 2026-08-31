import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ManifiestoService } from '../src/metricas/manifiesto.service';
import type { Manifiesto } from '../src/conciliacion/tipos';

/**
 * O-08 · El manifiesto de expedientes.
 *
 * ⚠ LA REGLA QUE ESTE ARCHIVO PROTEGE: el manifiesto registra lo que SALIO
 * POR EL CABLE, no lo que se planifico.
 *
 * Las secuencias se asignan al PLANIFICAR, con segundos de antelacion. Un
 * evento planificado que no llega a dispararse -porque el arnes se atraso o
 * porque el tope de peticiones en vuelo estaba lleno- se lleva su `sequence`
 * a la tumba. Si el manifiesto lo diera por emitido, la conciliacion acusaria
 * a C3 de perder un evento que nunca existio, y P4 daria un falso negativo
 * en la unica metrica que afirma que el orden se mantuvo.
 */

const doc = (rpf: string, sequence: number) => ({ rpf_id: rpf, sequence });
const RPF = '11111111-1111-4111-8111-111111111111';

function manifiesto(m: ManifiestoService): Manifiesto {
  return m.construir('prueba-x');
}

test('un expediente entero emitido y aceptado sale como un solo rango', () => {
  const m = new ManifiestoService();
  const lote = [1, 2, 3, 4, 5].map((s) => doc(RPF, s));

  m.emitidos('tenant-01', lote);
  m.resueltos(lote, 'aceptado');

  const r = manifiesto(m);
  assert.equal(r.expedientes.length, 1);
  assert.deepEqual(r.expedientes[0]!.emitidos, [[1, 5]]);
  assert.deepEqual(r.expedientes[0]!.aceptados, [[1, 5]]);
  assert.equal(r.expedientes[0]!.tenant, 'tenant-01');
  assert.equal(r.totales.emitidos, 5);
  assert.equal(r.totales.aceptados, 5);
  assert.equal(r.totales.en_vuelo, 0);
});

test('lo que el arnes no llego a disparar NO cuenta como emitido', () => {
  const m = new ManifiestoService();

  m.emitidos('tenant-01', [doc(RPF, 1), doc(RPF, 2)]);
  m.resueltos([doc(RPF, 1), doc(RPF, 2)], 'aceptado');
  // El 3 y el 4 se planificaron y el segundo se cerro antes de dispararlos.
  m.noEmitidos('tenant-01', [doc(RPF, 3), doc(RPF, 4)], 'retraso');

  const r = manifiesto(m);
  assert.deepEqual(r.expedientes[0]!.emitidos, [[1, 2]]);
  assert.deepEqual(r.expedientes[0]!.no_emitidos, [[3, 4]]);
  assert.equal(r.totales.emitidos, 2);
  assert.equal(r.totales.no_emitidos_retraso, 2);
  assert.equal(r.totales.no_emitidos_saturacion, 0);
});

test('el descarte por saturacion se cuenta aparte del atraso', () => {
  // Son culpables distintos: el atraso acusa al arnes, la saturacion dice que
  // el destino no drena. Mezclarlos borra esa distincion.
  const m = new ManifiestoService();
  m.noEmitidos('tenant-01', [doc(RPF, 1)], 'saturacion');
  m.noEmitidos('tenant-01', [doc(RPF, 2)], 'retraso');

  const r = manifiesto(m);
  assert.equal(r.totales.no_emitidos_saturacion, 1);
  assert.equal(r.totales.no_emitidos_retraso, 1);
  assert.equal(r.totales.emitidos, 0);
});

test('rechazado y fallido se separan de aceptado', () => {
  // Un 503 y un timeout no son lo mismo: en el primero el tenant contesto.
  const m = new ManifiestoService();
  m.emitidos('t1', [doc(RPF, 1)]);
  m.resueltos([doc(RPF, 1)], 'rechazado');
  m.emitidos('t1', [doc(RPF, 2)]);
  m.resueltos([doc(RPF, 2)], 'fallido');
  m.emitidos('t1', [doc(RPF, 3)]);   // se queda en vuelo

  const r = manifiesto(m);
  assert.deepEqual(r.expedientes[0]!.rechazados, [[1, 1]]);
  assert.deepEqual(r.expedientes[0]!.fallidos, [[2, 2]]);
  assert.equal(r.totales.aceptados, 0);
  assert.equal(r.totales.en_vuelo, 1, 'el 3 salio y nadie contesto todavia');
});

test('dos tenants nunca comparten expediente', () => {
  const m = new ManifiestoService();
  const otro = '22222222-2222-4222-8222-222222222222';
  m.emitidos('tenant-01', [doc(RPF, 1)]);
  m.emitidos('tenant-02', [doc(otro, 1)]);

  const r = manifiesto(m);
  assert.equal(r.totales.expedientes, 2);
  assert.deepEqual(r.expedientes.map((e) => e.tenant).sort(), ['tenant-01', 'tenant-02']);
});

test('el tope de expedientes se declara, no se aplica en silencio', () => {
  // Un manifiesto recortado que no lo diga se lee como "esos expedientes no
  // existieron", y la conciliacion daria un cero limpio sobre datos a medias.
  const m = new ManifiestoService(2);
  for (let i = 1; i <= 5; i++) {
    m.emitidos('t1', [doc(`0000000${i}-0000-4000-8000-000000000000`, 1)]);
  }

  const r = manifiesto(m);
  assert.equal(r.truncado, true);
  assert.equal(r.expedientes.length, 2);
  assert.equal(r.expedientes_omitidos, 3);
});

test('resolver un expediente omitido por el tope no lo resucita', () => {
  const m = new ManifiestoService(1);
  const a = '0000000a-0000-4000-8000-000000000000';
  const b = '0000000b-0000-4000-8000-000000000000';
  m.emitidos('t1', [doc(a, 1)]);
  m.emitidos('t1', [doc(b, 1)]);
  m.resueltos([doc(b, 1)], 'aceptado');

  const r = manifiesto(m);
  assert.equal(r.expedientes.length, 1);
  assert.equal(r.expedientes[0]!.rpf_id, a);
});

test('volcar escribe un JSON valido y devuelve la ruta', () => {
  const dir = mkdtempSync(join(tmpdir(), 'manifiesto-'));
  try {
    const m = new ManifiestoService();
    m.emitidos('t1', [doc(RPF, 1), doc(RPF, 2)]);
    m.resueltos([doc(RPF, 1), doc(RPF, 2)], 'aceptado');

    const ruta = m.volcar(dir, 'prueba-x');
    assert.ok(ruta && ruta.endsWith('prueba-x__manifiesto.json'), `ruta=${ruta}`);

    const leido = JSON.parse(readFileSync(ruta!, 'utf8')) as Manifiesto;
    assert.equal(leido.prueba, 'prueba-x');
    assert.equal(leido.totales.aceptados, 2);
    assert.deepEqual(leido.expedientes[0]!.aceptados, [[1, 2]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reiniciar deja el manifiesto vacio entre corridas', () => {
  // Sin esto, la segunda corrida del mismo proceso conciliaria contra los
  // expedientes de la primera y reportaria perdidas que ya se explicaron.
  const m = new ManifiestoService();
  m.emitidos('t1', [doc(RPF, 1)]);
  m.reiniciar();

  const r = manifiesto(m);
  assert.equal(r.totales.expedientes, 0);
  assert.equal(r.totales.emitidos, 0);
});
