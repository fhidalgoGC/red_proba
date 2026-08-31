import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { Tenant } from '../src/config/tipos';
import { calcularPesos, repartirEntero } from '../src/planificador/reparto';

const tenants = (n: number): Tenant[] =>
  Array.from({ length: n }, (_, i) => ({ id: `tenant-${i + 1}`, url: 'http://x', peso: null }));

test('zipf concentra el trafico y los pesos suman 1', () => {
  const p = calcularPesos(tenants(50), { tipo: 'zipf', exponente: 1.0 });
  assert.equal(p.length, 50);
  assert.ok(Math.abs(p.reduce((a, b) => a + b, 0) - 1) < 1e-12);

  // El punto de O-03: el mas grande se lleva ordenes de magnitud mas que la
  // cola larga. Con reparto uniforme esta relacion seria 1.
  assert.ok(p[0]! / p[49]! > 40, `relacion cabeza/cola ${(p[0]! / p[49]!).toFixed(1)}`);

  // A 2.000 ev/s el tenant grande supera los 300 msg/s de un MessageGroupId:
  // es exactamente el techo D-06 que la prueba quiere tocar, y que el reparto
  // uniforme jamas alcanzaria.
  assert.ok(p[0]! * 2000 > 300, `el tenant mayor solo llega a ${(p[0]! * 2000).toFixed(0)} ev/s`);
});

test('uniforme reparte parejo', () => {
  const p = calcularPesos(tenants(50), { tipo: 'uniforme', exponente: 1 });
  assert.ok(p.every((x) => Math.abs(x - 1 / 50) < 1e-12));
});

test('los pesos explicitos son todos o ninguno', () => {
  const mezcla: Tenant[] = [
    { id: 'a', url: 'http://x', peso: 3 },
    { id: 'b', url: 'http://x', peso: null },
  ];
  assert.throws(() => calcularPesos(mezcla, { tipo: 'zipf', exponente: 1 }), /todos los tenants/);
});

test('repartirEntero conserva el total exacto', () => {
  // Si la suma no diera el total, el numero contra el que se concilia P4 seria
  // distinto del que declara el perfil, y la conciliacion no cerraria nunca.
  for (const total of [2500, 2000, 3000, 7, 1]) {
    for (const n of [1, 3, 50]) {
      const pesos = calcularPesos(tenants(n), { tipo: 'zipf', exponente: 1 });
      const partes = repartirEntero(total, pesos);
      assert.equal(partes.reduce((a, b) => a + b, 0), total, `total=${total} n=${n}`);
      assert.ok(partes.every((x) => x >= 0));
    }
  }
});
