import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { conciliar } from '../src/conciliacion/conciliar';
import type { ExpedienteManifiesto, Manifiesto, VolcadoInbox } from '../src/conciliacion/tipos';

/**
 * O-09 · El cruce. Es la respuesta a P4.
 *
 * ⚠ POR QUE NO BASTA LA CONSULTA DE C4 (G-05).
 *
 * La consulta de huecos de C4 agrupa por `rpf_id` y compara el rango que ve
 * contra los valores distintos que tiene dentro. Eso solo encuentra huecos
 * INTERIORES: si falta el primero, `MIN` se desplaza; si falta la cola, `MAX`
 * se desplaza; si se perdio el expediente entero, no hay ni fila que agrupar.
 * Y el modo de fallo mas probable de esta PoC -una tarea de Fargate que muere
 * con su outbox efimero encima- se lleva justo la cola.
 *
 * El manifiesto cierra ese punto ciego porque trae el rango que se emitio de
 * verdad, desde fuera de C4.
 */

const RPF_A = 'aaaaaaaa-0000-4000-8000-000000000000';
const RPF_B = 'bbbbbbbb-0000-4000-8000-000000000000';

function exp(p: Partial<ExpedienteManifiesto> & { rpf_id: string }): ExpedienteManifiesto {
  return {
    tenant: 'tenant-01',
    emitidos: [], aceptados: [], rechazados: [], fallidos: [], no_emitidos: [],
    ...p,
  };
}

function man(expedientes: ExpedienteManifiesto[]): Manifiesto {
  const suma = (f: keyof ExpedienteManifiesto) =>
    expedientes.reduce((n, e) => n + (e[f] as [number, number][]).reduce((m, [a, b]) => m + b - a + 1, 0), 0);
  return {
    prueba: 'prueba-x',
    generado: '2026-08-30T00:00:00.000Z',
    truncado: false,
    expedientes_omitidos: 0,
    totales: {
      expedientes: expedientes.length,
      emitidos: suma('emitidos'),
      aceptados: suma('aceptados'),
      rechazados: suma('rechazados'),
      fallidos: suma('fallidos'),
      en_vuelo: 0,
      no_emitidos_retraso: suma('no_emitidos'),
      no_emitidos_saturacion: 0,
    },
    expedientes,
  };
}

function inbox(expedientes: VolcadoInbox['expedientes'], duplicados = 0): VolcadoInbox {
  return {
    generado: '2026-08-30T00:05:00.000Z',
    esquema: 'c4',
    desde: null,
    totales: {
      inbox: expedientes.reduce((n, e) => n + e.sequences.reduce((m, [a, b]) => m + b - a + 1, 0), 0),
      duplicados,
      expedientes: expedientes.length,
      descartes: 0,
    },
    expedientes,
  };
}

// ---------------------------------------------------------------------------

test('llego todo lo que se acepto: veredicto ok y cero perdida', () => {
  const v = conciliar(
    man([exp({ rpf_id: RPF_A, emitidos: [[1, 10]], aceptados: [[1, 10]] })]),
    inbox([{ rpf_id: RPF_A, sequences: [[1, 10]], duplicados: 3 }]),
  );

  assert.equal(v.ok, true);
  assert.equal(v.totales.faltan, 0);
  assert.equal(v.totales.llegados, 10);
  assert.equal(v.totales.duplicados, 3, 'un duplicado es salud, no defecto');
  assert.equal(v.detalle.length, 0);
});

test('hueco interior: es el hallazgo grave, invalida la afirmacion de orden', () => {
  const v = conciliar(
    man([exp({ rpf_id: RPF_A, emitidos: [[1, 10]], aceptados: [[1, 10]] })]),
    inbox([{ rpf_id: RPF_A, sequences: [[1, 4], [6, 10]], duplicados: 0 }]),
  );

  assert.equal(v.ok, false);
  assert.equal(v.clasificacion.perdida, 1);
  assert.equal(v.orden.expedientes_con_hueco_interior, 1);
  assert.deepEqual(v.detalle[0]!.faltan, [[5, 5]]);
  assert.equal(v.detalle[0]!.forma, 'hueco_interior');
  assert.equal(v.detalle[0]!.clasificacion, 'perdida');
});

test('cola truncada: el punto ciego de G-05, aqui SI se ve', () => {
  // La consulta de C4 ve 1..7 densos y no reporta nada.
  const v = conciliar(
    man([exp({ rpf_id: RPF_A, emitidos: [[1, 10]], aceptados: [[1, 10]] })]),
    inbox([{ rpf_id: RPF_A, sequences: [[1, 7]], duplicados: 0 }]),
  );

  assert.equal(v.ok, false);
  assert.deepEqual(v.detalle[0]!.faltan, [[8, 10]]);
  assert.equal(v.detalle[0]!.forma, 'cola');
  assert.equal(v.orden.expedientes_truncados, 1);
  assert.equal(v.totales.faltan, 3);
});

test('cabeza ausente: el otro punto ciego de G-05', () => {
  const v = conciliar(
    man([exp({ rpf_id: RPF_A, emitidos: [[1, 10]], aceptados: [[1, 10]] })]),
    inbox([{ rpf_id: RPF_A, sequences: [[3, 10]], duplicados: 0 }]),
  );

  assert.deepEqual(v.detalle[0]!.faltan, [[1, 2]]);
  assert.equal(v.detalle[0]!.forma, 'cabeza');
});

test('expediente entero desaparecido: sin manifiesto no habria ni fila que mirar', () => {
  const v = conciliar(
    man([
      exp({ rpf_id: RPF_A, emitidos: [[1, 5]], aceptados: [[1, 5]] }),
      exp({ rpf_id: RPF_B, emitidos: [[1, 5]], aceptados: [[1, 5]] }),
    ]),
    inbox([{ rpf_id: RPF_A, sequences: [[1, 5]], duplicados: 0 }]),
  );

  assert.equal(v.ok, false);
  assert.equal(v.orden.expedientes_ausentes, 1);
  assert.equal(v.detalle[0]!.rpf_id, RPF_B);
  assert.equal(v.detalle[0]!.forma, 'ausente');
  assert.equal(v.totales.faltan, 5);
});

test('lo que el arnes no emitio no es una perdida y no rompe el veredicto', () => {
  // ⚠ La trampa principal. El 8, 9 y 10 se planificaron y nunca salieron.
  // Contarlos como hueco acusaria a C3 de perder eventos que no existieron.
  const v = conciliar(
    man([exp({
      rpf_id: RPF_A,
      emitidos: [[1, 7]], aceptados: [[1, 7]], no_emitidos: [[8, 10]],
    })]),
    inbox([{ rpf_id: RPF_A, sequences: [[1, 7]], duplicados: 0 }]),
  );

  assert.equal(v.ok, true);
  assert.equal(v.clasificacion.perdida, 0);
  assert.equal(v.clasificacion.arnes, 3);
  assert.equal(v.totales.no_emitidos, 3);
  assert.equal(v.detalle.length, 0);
});

test('un evento cuya request fallo no se le puede exigir a C3', () => {
  // Salio por el cable pero nadie contesto: puede haber llegado o no. Se
  // reporta como sin_confirmar, no como perdida, y no tumba el veredicto.
  const v = conciliar(
    man([exp({
      rpf_id: RPF_A,
      emitidos: [[1, 10]], aceptados: [[1, 9]], fallidos: [[10, 10]],
    })]),
    inbox([{ rpf_id: RPF_A, sequences: [[1, 9]], duplicados: 0 }]),
  );

  assert.equal(v.ok, true);
  assert.equal(v.clasificacion.perdida, 0);
  assert.equal(v.clasificacion.sin_confirmar, 1);
  assert.equal(v.detalle[0]!.clasificacion, 'sin_confirmar');
});

test('un expediente en C4 que el manifiesto no conoce se reporta aparte', () => {
  // O es de otra corrida que quedo en la misma base, o alguien inyecto. Las
  // dos cosas hay que verlas; ninguna se puede confundir con una perdida.
  const v = conciliar(
    man([exp({ rpf_id: RPF_A, emitidos: [[1, 5]], aceptados: [[1, 5]] })]),
    inbox([
      { rpf_id: RPF_A, sequences: [[1, 5]], duplicados: 0 },
      { rpf_id: RPF_B, sequences: [[1, 2]], duplicados: 0 },
    ]),
  );

  assert.equal(v.totales.desconocidos, 1);
  assert.deepEqual(v.desconocidos, [RPF_B]);
  assert.equal(v.totales.faltan, 0);
});

test('un manifiesto truncado nunca produce un veredicto ok', () => {
  // Conciliar contra datos a medias y declarar "cero perdidas" es peor que no
  // conciliar: es un cero que nadie puede defender.
  const m = man([exp({ rpf_id: RPF_A, emitidos: [[1, 5]], aceptados: [[1, 5]] })]);
  m.truncado = true;
  m.expedientes_omitidos = 40;

  const v = conciliar(m, inbox([{ rpf_id: RPF_A, sequences: [[1, 5]], duplicados: 0 }]));
  assert.equal(v.ok, false);
  assert.ok(v.avisos.some((a) => /truncad/i.test(a)), v.avisos.join(' · '));
});

test('el detalle se corta con tope declarado, nunca en silencio', () => {
  const muchos = Array.from({ length: 30 }, (_, i) =>
    exp({ rpf_id: `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`,
          emitidos: [[1, 2]], aceptados: [[1, 2]] }));

  const v = conciliar(man(muchos), inbox([]), { topeDetalle: 10 });
  assert.equal(v.detalle.length, 10);
  assert.equal(v.detalle_omitido, 20);
  assert.equal(v.orden.expedientes_ausentes, 30, 'el conteo es completo aunque el detalle se corte');
});

test('un hueco que dejo un rechazo del destino no acusa al orden', () => {
  // ⚠ Lo encontro la prueba de punta a punta. Un 503 deja su `sequence`
  // ausente en C4, pero ese evento nunca entro en el sistema: contarlo como
  // hueco de orden dispararia la metrica mas grave de la corrida por un
  // rechazo del destino, que es exactamente lo que el desglose de O-06
  // existe para separar.
  const v = conciliar(
    man([exp({
      rpf_id: RPF_A,
      emitidos: [[1, 10]], aceptados: [[1, 4], [6, 10]], rechazados: [[5, 5]],
    })]),
    inbox([{ rpf_id: RPF_A, sequences: [[1, 4], [6, 10]], duplicados: 0 }]),
  );

  assert.equal(v.ok, true);
  assert.equal(v.orden.expedientes_con_hueco_interior, 0, 'el orden no se toca');
  assert.equal(v.clasificacion.sin_confirmar, 1);
  // Pero el hueco NO desaparece del informe: se ve, con su culpable.
  assert.equal(v.detalle.length, 1);
  assert.equal(v.detalle[0]!.forma, 'hueco_interior');
  assert.equal(v.detalle[0]!.clasificacion, 'sin_confirmar');
});

test('un expediente mixto cuenta en orden solo por la parte exigible', () => {
  // Falta el 3 (aceptado → perdida) y el 10 (rechazado → sin confirmar).
  // La forma que acusa al orden es la del 3, que es interior.
  const v = conciliar(
    man([exp({
      rpf_id: RPF_A,
      emitidos: [[1, 10]], aceptados: [[1, 9]], rechazados: [[10, 10]],
    })]),
    inbox([{ rpf_id: RPF_A, sequences: [[1, 2], [4, 9]], duplicados: 0 }]),
  );

  assert.equal(v.ok, false);
  assert.equal(v.orden.expedientes_con_hueco_interior, 1);
  assert.equal(v.orden.expedientes_truncados, 0, 'la cola que falta es la rechazada');
  assert.equal(v.detalle[0]!.clasificacion, 'mixto');
  assert.deepEqual(v.detalle[0]!.faltan, [[3, 3], [10, 10]]);
});
