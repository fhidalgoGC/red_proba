import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { aRangos, contar, expandir, primero, restar, ultimo } from '../src/conciliacion/rangos';

/**
 * Los rangos son el formato en el que se guarda "que sequences salieron".
 *
 * Existen por una razon de tamaño: un expediente de 10 eventos son 10 enteros,
 * pero una corrida de 25 millones de eventos son 2,5 millones de expedientes.
 * Guardar la lista densa multiplicaria el manifiesto por diez sin añadir un
 * solo dato — las secuencias son consecutivas salvo cuando hay un hueco, y el
 * hueco es justo lo que se quiere ver.
 */

test('aRangos comprime lo consecutivo y separa lo que tiene hueco', () => {
  assert.deepEqual(aRangos([1, 2, 3, 4, 5]), [[1, 5]]);
  assert.deepEqual(aRangos([1, 2, 4, 5]), [[1, 2], [4, 5]]);
  assert.deepEqual(aRangos([3]), [[3, 3]]);
  assert.deepEqual(aRangos([]), []);
});

test('aRangos ordena y deduplica: el orden de llegada no es el orden logico', () => {
  // Con lotes concurrentes, el 7 puede registrarse antes que el 5.
  assert.deepEqual(aRangos([5, 3, 4, 1, 2]), [[1, 5]]);
  assert.deepEqual(aRangos([2, 2, 3, 3, 3]), [[2, 3]]);
});

test('restar quita lo que llego y deja exactamente lo que falta', () => {
  // El caso que responde P4: se emitio 1..10 y llegaron todos menos el 5.
  assert.deepEqual(restar([[1, 10]], [[1, 4], [6, 10]]), [[5, 5]]);

  // Cola truncada: la tarea murio con los tres ultimos dentro.
  assert.deepEqual(restar([[1, 10]], [[1, 7]]), [[8, 10]]);

  // Cabeza ausente: el caso que la consulta de C4 NO ve.
  assert.deepEqual(restar([[1, 10]], [[3, 10]]), [[1, 2]]);

  // Nada que restar y nada que quede.
  assert.deepEqual(restar([[1, 10]], [[1, 10]]), []);
  assert.deepEqual(restar([], [[1, 10]]), []);
  assert.deepEqual(restar([[1, 3]], []), [[1, 3]]);
});

test('restar parte un rango por el medio', () => {
  assert.deepEqual(restar([[1, 10]], [[4, 6]]), [[1, 3], [7, 10]]);
  assert.deepEqual(restar([[1, 10], [20, 25]], [[5, 21]]), [[1, 4], [22, 25]]);
});

test('contar no expande: el total tiene que salir del rango', () => {
  // Si contar expandiera, un manifiesto de 25 millones de eventos se
  // materializaria entero en memoria solo para sumar.
  assert.equal(contar([[1, 10]]), 10);
  assert.equal(contar([[1, 2], [4, 5]]), 4);
  assert.equal(contar([]), 0);
  assert.equal(contar([[1, 1_000_000]]), 1_000_000);
});

test('primero y ultimo dan los extremos sin recorrer', () => {
  assert.equal(primero([[3, 7], [10, 12]]), 3);
  assert.equal(ultimo([[3, 7], [10, 12]]), 12);
  assert.equal(primero([]), null);
  assert.equal(ultimo([]), null);
});

test('expandir respeta un tope y avisa de que lo aplico', () => {
  // Un expediente con 10.000 huecos no puede volcar 10.000 enteros al informe:
  // se corta, pero el corte se declara. Un recorte silencioso se lee como
  // "solo faltaban tres".
  assert.deepEqual(expandir([[1, 5]], 10), { valores: [1, 2, 3, 4, 5], truncado: 0 });
  assert.deepEqual(expandir([[1, 5]], 3), { valores: [1, 2, 3], truncado: 2 });
});
