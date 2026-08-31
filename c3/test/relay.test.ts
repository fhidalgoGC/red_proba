/**
 * C-06 · el relay, contra Postgres real y un publicador de mentira.
 *
 * La cola se sustituye a proposito: lo que hay que probar aqui no es SQS —eso
 * se prueba en `e2e-kms.ts` contra la cola real— sino las cosas que SOLO se
 * pueden provocar controlando la respuesta del publicador:
 *
 *   · que `attempts` suba AL RECLAMAR y no al fallar;
 *   · que el backoff sea creciente y con jitter;
 *   · que un error permanente vaya directo a FAILED;
 *   · que el circuit breaker se abra tras un lote entero fallido;
 *   · que `FOR UPDATE SKIP LOCKED` impida que dos relays tomen lo mismo;
 *   · que el `finally` libere el guardia aunque el tick reviente.
 *
 * Contra la cola real ninguna de esas se puede forzar sin romper algo.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { BdService } from '../src/bd/bd.service';
import { OutboxRepository, type Reclamado } from '../src/bd/outbox.repository';
import { ConfigService } from '../src/config/config.service';
import { RelayService } from '../src/relay/relay.service';
import type { PublicadorService, ResultadoEnvio } from '../src/relay/publicador.service';

const ESQUEMA = 'c3_relay_test';
// ⚠ Base PROPIA de C3, no la de C4. Son dominios sin ruta de red entre ellos
// (D-03); si los tests compartieran base, cualquiera podria escribir una
// conciliacion con JOIN que pasaria aqui y seria imposible en produccion.
const BD = process.env.DATABASE_URL ?? 'postgres://cw:cwlocal@127.0.0.1:5433/rpf_c3_test';

let bd: BdService;
let outbox: OutboxRepository;
let config: ConfigService;

/** Un publicador que hace lo que le digamos. */
class PublicadorFalso {
  modo: 'ok' | 'reintentar' | 'permanente' = 'ok';
  llamadas = 0;
  vistos: Reclamado[][] = [];

  async publicar(filas: Reclamado[]): Promise<ResultadoEnvio> {
    this.llamadas += 1;
    this.vistos.push(filas);
    const e6 = new Date().toISOString();
    if (filas.length === 0) return { ok: [], reintentar: [], permanentes: [], e6 };
    if (this.modo === 'ok') return { ok: filas.map((f) => f.id), reintentar: [], permanentes: [], e6 };
    const items = filas.map((f) => ({ id: f.id, codigo: 'X', detalle: 'de prueba' }));
    return this.modo === 'permanente'
      ? { ok: [], reintentar: [], permanentes: items, e6 }
      : { ok: [], reintentar: items, permanentes: [], e6 };
  }
}

/** El SchedulerRegistry solo se usa para reprogramar; con esto basta. */
const schedulerFalso = {
  deleteInterval: () => undefined,
  addInterval: () => undefined,
} as never;

function nuevoRelay(pub: PublicadorFalso): RelayService {
  return new RelayService(config, outbox, pub as unknown as PublicadorService, schedulerFalso);
}

/** Mete N filas PENDING directamente, sin pasar por el pipeline. */
async function sembrar(n: number, rpfId = randomUUID()): Promise<void> {
  for (let i = 0; i < n; i++) {
    await bd.pool.query(
      `INSERT INTO ${ESQUEMA}.outbox (rpf_id, payload_hash, envelope, e0_listo, e1_canonizado, e2_firmado, e3_cifrado, e4_commit)
       VALUES ($1, $2, '{"v":1}'::jsonb, now(), now(), now(), now(), now())`,
      [rpfId, randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')],
    );
  }
}

before(async () => {
  process.env.DATABASE_URL = BD;
  process.env.C3_ESQUEMA = ESQUEMA;
  process.env.SQS_QUEUE_URL = 'https://sqs.us-west-2.amazonaws.com/000/falsa.fifo';
  process.env.TENANT_ID = 'tenant-relay';
  delete process.env.KMS_SIGN_KEY_ID;
  delete process.env.KMS_HMAC_KEY_ID;
  delete process.env.KMS_ENCRYPT_KEY_ID;

  config = new ConfigService();
  bd = new BdService(config);
  await bd.pool.query(`DROP SCHEMA IF EXISTS ${ESQUEMA} CASCADE`);
  await bd.onApplicationBootstrap();
  outbox = new OutboxRepository(bd);
});

beforeEach(async () => {
  await bd.pool.query(`TRUNCATE ${ESQUEMA}.outbox, ${ESQUEMA}.expediente`);
});

after(async () => {
  await bd.pool.query(`DROP SCHEMA IF EXISTS ${ESQUEMA} CASCADE`);
  await bd.onApplicationShutdown();
});

// ─────────────────────────────────────────────────────────────────────────────

test('el camino feliz: PENDING → SENT con e5 y e6', async () => {
  await sembrar(3);
  const pub = new PublicadorFalso();
  await nuevoRelay(pub).tick();

  const { rows } = await bd.pool.query(
    `SELECT status, sent_at, e5_reclamado, e6_publicado, attempts FROM ${ESQUEMA}.outbox`);
  assert.equal(rows.length, 3);
  for (const r of rows) {
    assert.equal(r.status, 'SENT');
    assert.ok(r.sent_at, 'sent_at sin poner');
    assert.ok(r.e5_reclamado, 'e5 lo pone el reclamo');
    assert.ok(r.e6_publicado, 'e6 lo pone la confirmacion de SQS');
    assert.ok(r.e5_reclamado <= r.e6_publicado);
  }
});

test('attempts sube AL RECLAMAR, no al fallar', async () => {
  await sembrar(1);
  // Aun sin publicar nada, el reclamo ya tiene que haber incrementado.
  const filas = await outbox.reclamar(10, 300);
  assert.equal(filas[0]!.attempts, 1);

  const { rows } = await bd.pool.query(`SELECT attempts FROM ${ESQUEMA}.outbox`);
  assert.equal(rows[0]!.attempts, 1, 'si subiera al fallar, un ROLLBACK lo desharia');
});

test('el backoff crece y lleva jitter', async () => {
  await sembrar(1);
  const esperas: number[] = [];
  for (let i = 0; i < 4; i++) {
    await bd.pool.query(`UPDATE ${ESQUEMA}.outbox SET next_attempt = now()`);
    await outbox.reclamar(10, 300);
    const { rows } = await bd.pool.query(
      `SELECT extract(epoch FROM (next_attempt - now())) AS s FROM ${ESQUEMA}.outbox`);
    esperas.push(Number(rows[0]!.s));
  }
  // 2^0, 2^1, 2^2, 2^3 segundos de base, cada uno × (0.5 + random()).
  assert.ok(esperas[0]! > 0, `la primera espera fue ${esperas[0]}`);
  assert.ok(esperas[3]! > esperas[0]!, `no crecio: ${esperas.join(', ')}`);
  // Con jitter, dos esperas de la misma base nunca coinciden exactamente.
  assert.notEqual(esperas[1], esperas[2]);
});

test('el backoff tiene techo', async () => {
  await sembrar(1);
  await bd.pool.query(`UPDATE ${ESQUEMA}.outbox SET attempts = 30, next_attempt = now()`);
  await outbox.reclamar(10, 300);
  const { rows } = await bd.pool.query(
    `SELECT extract(epoch FROM (next_attempt - now())) AS s FROM ${ESQUEMA}.outbox`);
  // 2^30 s serian 34 años. Con el techo de 300 y el jitter, máximo 450.
  assert.ok(Number(rows[0]!.s) <= 450, `sin techo: ${rows[0]!.s} s`);
});

test('un error permanente va directo a FAILED, sin gastar los intentos', async () => {
  await sembrar(2);
  const pub = new PublicadorFalso();
  pub.modo = 'permanente';
  await nuevoRelay(pub).tick();

  const { rows } = await bd.pool.query(
    `SELECT status, attempts, last_error_code FROM ${ESQUEMA}.outbox`);
  for (const r of rows) {
    assert.equal(r.status, 'FAILED');
    assert.equal(r.attempts, 1, 'reintentar 10 veces no arregla un error permanente');
    assert.equal(r.last_error_code, 'X', 'sin codigo, un FAILED no es accionable');
  }
});

test('un error transitorio deja la fila PENDING para que se reintente sola', async () => {
  await sembrar(1);
  const pub = new PublicadorFalso();
  pub.modo = 'reintentar';
  await nuevoRelay(pub).tick();

  const { rows } = await bd.pool.query(
    `SELECT status, attempts, last_error_code, next_attempt > now() AS futuro FROM ${ESQUEMA}.outbox`);
  assert.equal(rows[0]!.status, 'PENDING');
  assert.equal(rows[0]!.attempts, 1);
  assert.equal(rows[0]!.futuro, true, 'sin next_attempt futuro giraria en bucle');
});

test('el circuit breaker se abre cuando no pasa NI UNA del lote', async () => {
  await sembrar(3);
  const pub = new PublicadorFalso();
  pub.modo = 'reintentar';
  const relay = nuevoRelay(pub);
  await relay.tick();

  const e = relay.estado();
  assert.equal(e.fallos_seguidos, 1);
  assert.ok((e.pausado_ms as number) > 0, 'sin breaker, seguiria martillando un SQS caido');

  // Y con el breaker abierto, el siguiente tick no toca la base.
  const antes = outbox.contadores.reclamadas;
  await relay.tick();
  assert.equal(outbox.contadores.reclamadas, antes, 'el tick pausado no debe reclamar');
});

test('el breaker se cierra en cuanto vuelve a pasar algo', async () => {
  await sembrar(1);
  const pub = new PublicadorFalso();
  pub.modo = 'reintentar';
  const relay = nuevoRelay(pub);
  await relay.tick();
  assert.ok((relay.estado().pausado_ms as number) > 0);

  // Se fuerza el fin de la pausa y se deja que publique.
  (relay as unknown as { pausaHasta: number }).pausaHasta = 0;
  await bd.pool.query(`UPDATE ${ESQUEMA}.outbox SET next_attempt = now()`);
  pub.modo = 'ok';
  await relay.tick();

  assert.equal(relay.estado().fallos_seguidos, 0);
  assert.equal(relay.estado().pausado_ms, 0);
});

test('el DRENADO vacía el outbox en un solo tick', async () => {
  // 25 filas con lote de 10: sin drenado harían falta 3 ticks, y el techo
  // sería 10 mensajes cada OUTBOX_POLL_MS.
  await sembrar(25);
  const pub = new PublicadorFalso();
  await nuevoRelay(pub).tick();

  const { rows } = await bd.pool.query(
    `SELECT count(*)::int n FROM ${ESQUEMA}.outbox WHERE status = 'PENDING'`);
  assert.equal(rows[0]!.n, 0, 'quedaron pendientes: el drenado no funciona');
  assert.equal(pub.llamadas, 3, `esperaba 3 lotes de 10/10/5, hubo ${pub.llamadas}`);
});

test('SKIP LOCKED · dos relays a la vez no se pisan las filas', async () => {
  await sembrar(20);
  const a = new PublicadorFalso();
  const b = new PublicadorFalso();
  await Promise.all([nuevoRelay(a).tick(), nuevoRelay(b).tick()]);

  const ids = [...a.vistos.flat(), ...b.vistos.flat()].map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length, 'una fila la tomaron los dos');

  const { rows } = await bd.pool.query(
    `SELECT count(*)::int n FROM ${ESQUEMA}.outbox WHERE status = 'SENT'`);
  assert.equal(rows[0]!.n, 20);
});

test('el guardia impide dos ticks solapados', async () => {
  await sembrar(5);
  const pub = new PublicadorFalso();
  const relay = nuevoRelay(pub);
  await Promise.all([relay.tick(), relay.tick(), relay.tick()]);
  // Los dos que llegan tarde se van sin hacer nada; el primero drena todo.
  assert.equal(relay.contadores.ticks, 1);
});

test('el finally libera el guardia aunque el tick reviente', async () => {
  await sembrar(1);
  const roto = {
    publicar: () => Promise.reject(new Error('boom')),
  } as unknown as PublicadorService;
  const relay = new RelayService(config, outbox, roto, schedulerFalso);

  await relay.tick(); // no debe propagar
  assert.equal(relay.estado().ocupado, false, 'sin el finally, el relay queda congelado para siempre');

  // Y con el guardia libre, el siguiente tick sí trabaja.
  const pub = new PublicadorFalso();
  const sano = nuevoRelay(pub);
  await bd.pool.query(`UPDATE ${ESQUEMA}.outbox SET next_attempt = now()`);
  await sano.tick();
  assert.equal(pub.llamadas > 0, true);
});

test('C-07 · al parar no se toma trabajo nuevo, pero nada se pierde', async () => {
  await sembrar(4);
  const pub = new PublicadorFalso();
  const relay = nuevoRelay(pub);
  relay.onApplicationShutdown();
  await relay.tick();

  assert.equal(pub.llamadas, 0);
  const { rows } = await bd.pool.query(
    `SELECT count(*)::int n FROM ${ESQUEMA}.outbox WHERE status = 'PENDING'`);
  assert.equal(rows[0]!.n, 4, 'siguen en el outbox: otro contenedor las tomara');
});

test('la purga borra enviadas viejas y agota las que pasaron el maximo', async () => {
  await sembrar(3);
  await bd.pool.query(
    `UPDATE ${ESQUEMA}.outbox SET status='SENT', sent_at = now() - interval '5 hours'
      WHERE id IN (SELECT id FROM ${ESQUEMA}.outbox LIMIT 1)`);
  await bd.pool.query(
    `UPDATE ${ESQUEMA}.outbox SET attempts = 99
      WHERE status='PENDING' AND id IN (SELECT id FROM ${ESQUEMA}.outbox WHERE status='PENDING' LIMIT 1)`);

  const r = await outbox.purgar(10);
  assert.equal(r.borradas, 1);
  assert.equal(r.fallidas, 1, 'sin esto una fila agotada se reintenta para siempre');

  const { rows } = await bd.pool.query(
    `SELECT status, count(*)::int n FROM ${ESQUEMA}.outbox GROUP BY status ORDER BY status`);
  assert.deepEqual(rows, [{ status: 'FAILED', n: 1 }, { status: 'PENDING', n: 1 }]);
});

test('una fila SENT reciente NO se borra', async () => {
  await sembrar(1);
  await bd.pool.query(`UPDATE ${ESQUEMA}.outbox SET status='SENT', sent_at = now()`);
  const r = await outbox.purgar(10);
  assert.equal(r.borradas, 0, 'borrarla dejaria a P4 sin con que conciliar');
});
