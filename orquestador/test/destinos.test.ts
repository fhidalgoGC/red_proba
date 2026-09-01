/**
 * A QUIEN LE PEGA UNA CORRIDA · el campo `client` del `POST /batch`.
 *
 * ── Que cambio y por que ──────────────────────────────────────────────────
 *
 * Un numero era un INDICE: `client: 40` significaba "el tenant que hace 40",
 * uno solo. Ahora es una CANTIDAD: "los primeros 40 endpoints".
 *
 * El motivo es que la forma natural de pedir una prueba de escala es "contra
 * 40 clientes", y con la semantica vieja eso se escribia `"all"` sobre un
 * despliegue de exactamente 40 — es decir, el numero de destinos no se podia
 * elegir sin volver a desplegar. Y el fallo era mudo en la direccion peor:
 * pedias 40 y corrias contra UNO, con un informe que parecia correcto porque
 * nada habia fallado.
 *
 * ── Que NO cambia ─────────────────────────────────────────────────────────
 *
 * `client: 1` sigue dando tenant-01: con las dos semanticas es lo mismo, y es
 * la forma que usan todos los ejemplos y `sh start`. Para apuntar a UN tenant
 * concreto que no sea el primero esta el id literal (`"tenant-07"`), que es
 * explicito y no depende del orden.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolverTenants } from '../src/corrida/corrida.service';
import type { Tenant } from '../src/config/tipos';

const flota = (n: number): Tenant[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `tenant-${String(i + 1).padStart(2, '0')}`,
    url: `http://api-${String(i + 1).padStart(2, '0')}.poc.local:8080`,
    peso: null,
  }));

const ids = (ts: Tenant[]) => ts.map((t) => t.id);

test('un numero son CUANTOS destinos, no cual: 40 da los 40 primeros', () => {
  const r = resolverTenants(flota(50), 40);
  assert.equal(r.length, 40);
  assert.equal(r[0]!.id, 'tenant-01', 'el primero TIENE que entrar');
  assert.equal(r[39]!.id, 'tenant-40');
});

test('la cadena "40" es lo mismo que el numero 40', () => {
  assert.deepEqual(ids(resolverTenants(flota(50), '40')), ids(resolverTenants(flota(50), 40)));
});

test('client: 1 sigue dando solo tenant-01 — no rompe los ejemplos de siempre', () => {
  assert.deepEqual(ids(resolverTenants(flota(50), 1)), ['tenant-01']);
});

test('"all" son todos, y sigue empezando por el primero', () => {
  const r = resolverTenants(flota(39), 'all');
  assert.equal(r.length, 39);
  assert.equal(r[0]!.id, 'tenant-01');
});

test('sin client, todos', () => {
  assert.equal(resolverTenants(flota(7), undefined).length, 7);
  assert.equal(resolverTenants(flota(7), null).length, 7);
});

test('el id literal apunta a UNO, sin depender del orden', () => {
  assert.deepEqual(ids(resolverTenants(flota(50), 'tenant-07')), ['tenant-07']);
});

/**
 * ⚠ EL CASO QUE MOTIVO TODO ESTO.
 *
 * Pedir mas destinos de los que hay tiene que ser un ERROR, no un recorte
 * silencioso. Si `client: 40` sobre 39 tenants devolviera los 39, el informe
 * diria "40 clientes" y habrias medido 39 — un 2,5% de diferencia que nadie
 * detecta a ojo y que invalida la comparacion entre corridas.
 */
test('pedir mas destinos de los que hay falla, y dice cuantos hay', () => {
  assert.throws(
    () => resolverTenants(flota(39), 40),
    (e: Error) => e.message.includes('40') && e.message.includes('39'),
  );
});

test('cero y negativos no son una cantidad valida', () => {
  assert.throws(() => resolverTenants(flota(39), 0));
  assert.throws(() => resolverTenants(flota(39), -1));
});

test('un decimal no es una cantidad de endpoints', () => {
  assert.throws(() => resolverTenants(flota(39), 2.5));
});

/**
 * Sin la comprobacion de tipo, `Number(true)` da 1 y `"client": true` correria
 * contra el primer tenant en silencio: una peticion mal formada produciendo
 * una corrida que parece buena.
 */
test('un booleano no vale, aunque Number(true) sea 1', () => {
  assert.throws(() => resolverTenants(flota(39), true as unknown as number));
});

test('un id que no existe falla en vez de caer al indice', () => {
  assert.throws(() => resolverTenants(flota(39), 'tenant-99'));
});

test('sin tenants configurados, falla claro', () => {
  assert.throws(() => resolverTenants([], 'all'), /ningun tenant/);
});
