import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { BdService } from '../src/bd/bd.service';
import { InboxRepository, type EventoAPersistir } from '../src/bd/inbox.repository';
import { ConfigService } from '../src/config/config.service';
import { BD, COLA } from './entorno';

/**
 * G-03 e idempotencia contra un Postgres de verdad.
 *
 * ⚠ Por que este test existe aparte del de punta a punta: un duplicado real
 * llega a C4 cuando SQS REENTREGA, y eso ocurre al vencer el visibility
 * timeout — 60 s en la cola de la PoC. Probar la idempotencia esperando un
 * minuto por caso convierte la suite en algo que nadie corre. Aqui se ejerce
 * el MISMO camino de codigo -`persistir()` dos veces con el mismo payload_hash-
 * en milisegundos. El de punta a punta comprueba aparte que la reentrega
 * ocurre de verdad.
 */
const ESQUEMA = 'c4_test_inbox';

let bd: BdService;
let inbox: InboxRepository;

function config(): ConfigService {
  process.env.SQS_QUEUE_URL = COLA;
  process.env.DATABASE_URL = BD;
  process.env.C4_ESQUEMA = ESQUEMA;
  return new ConfigService();
}

function evento(sobre: Partial<EventoAPersistir> = {}): EventoAPersistir {
  const rpf = sobre.rpfId ?? randomUUID();
  const ahora = new Date();
  return {
    payloadHash: randomUUID().replace(/-/g, ''),
    rpfId: rpf,
    sequence: 1,
    eventId: randomUUID(),
    eventType: 'fiscal.document.issued',
    schemaVersion: '1.0.0',
    partyId: 'hmac:' + '0'.repeat(64),
    keyId: 'arn:aws:kms:us-west-2:1:key/firma',
    sigAlg: 'Ed25519',
    occurredAt: ahora.toISOString(),
    messageId: randomUUID(),
    recepciones: 1,
    bytesSobre: 4300,
    bytesCanonicos: 4096,
    sqsEnviado: ahora,
    e7: ahora,
    e7b: ahora,
    e8: ahora,
    e9: ahora,
    payload: {
      rpf_id: rpf,
      sequence: 1,
      counterparty: { cnpj: '11222333000144', uf: 'SP' },
      document: { access_key: '1'.repeat(44) },
      totals: { products: '18450.00' },
    },
    ...sobre,
  };
}

before(async () => {
  const c = config();
  bd = new BdService(c);
  await bd.pool.query(`DROP SCHEMA IF EXISTS ${ESQUEMA} CASCADE`);
  await bd.onApplicationBootstrap();
  inbox = new InboxRepository(bd, c);
});

after(async () => {
  await bd.pool.query(`DROP SCHEMA IF EXISTS ${ESQUEMA} CASCADE`);
  await bd.onApplicationShutdown();
});

test('el primer evento se persiste y se proyecta a los cinco schemas', async () => {
  const ev = evento();
  const r = await inbox.persistir(ev);
  assert.equal(r.nuevo, true);

  const q = async (sql: string) =>
    Number((await bd.pool.query(sql)).rows[0].n);

  assert.equal(await q(`SELECT COUNT(*) n FROM ${ESQUEMA}.inbox`), 1);
  assert.equal(await q(`SELECT COUNT(*) n FROM ${ESQUEMA}.journal`), 1);
  assert.equal(await q(`SELECT COUNT(*) n FROM ${ESQUEMA}.case_header`), 1);
  assert.equal(await q(`SELECT COUNT(*) n FROM ${ESQUEMA}.shared_map`), 1);
  assert.equal(await q(`SELECT COUNT(*) n FROM ${ESQUEMA}.policy_registry`), 1);
  assert.equal(await q(`SELECT COUNT(*) n FROM ${ESQUEMA}.key_registry`), 1);
});

test('el MISMO payload_hash no vuelve a escribir el libro', async () => {
  const ev = evento();
  assert.equal((await inbox.persistir(ev)).nuevo, true);

  const antes = Number(
    (await bd.pool.query(`SELECT COUNT(*) n FROM ${ESQUEMA}.journal`)).rows[0].n,
  );

  // Tres reentregas mas del mismo evento.
  for (let i = 0; i < 3; i++) {
    assert.equal((await inbox.persistir(ev)).nuevo, false, 'un duplicado se colo como nuevo');
  }

  const despues = Number(
    (await bd.pool.query(`SELECT COUNT(*) n FROM ${ESQUEMA}.journal`)).rows[0].n,
  );
  // ⚠ Lo que este assert protege: sin el, cada reintento del relay duplicaria
  // un asiento fiscal en un libro append-only. No hay forma de corregirlo
  // despues sin romper el "append-only".
  assert.equal(despues, antes, 'el journal creció con un duplicado');

  const fila = (
    await bd.pool.query(
      `SELECT duplicados, recepciones FROM ${ESQUEMA}.inbox WHERE payload_hash = $1`,
      [ev.payloadHash],
    )
  ).rows[0];
  assert.equal(Number(fila.duplicados), 3, 'los duplicados tienen que CONTARSE, no ignorarse');
  assert.equal(Number(fila.recepciones), 4);
});

test('e10 se estampa y llega despues de e9', async () => {
  const ev = evento();
  const r = await inbox.persistir(ev);
  await inbox.estamparE10([{ payloadHash: ev.payloadHash, e10: r.e10 }]);

  const f = (
    await bd.pool.query(
      `SELECT e7_recibido, e9_verificado, e10_persistido FROM ${ESQUEMA}.inbox WHERE payload_hash=$1`,
      [ev.payloadHash],
    )
  ).rows[0];
  assert.ok(f.e10_persistido, 'e10 quedo en null: sin el no hay final de la medicion');
  assert.ok(
    new Date(f.e10_persistido).getTime() >= new Date(f.e9_verificado).getTime(),
    'e10 antes que e9',
  );
});

test('el case_header acumula el expediente y no se desordena al reprocesar', async () => {
  const rpf = randomUUID();
  for (const seq of [1, 2, 3]) {
    await inbox.persistir(evento({ rpfId: rpf, sequence: seq }));
  }
  // Un reproceso fuera de orden: FIFO ordena por grupo, pero un mensaje que
  // reaparece tras un visibility timeout puede volver detras de otro.
  await inbox.persistir(evento({ rpfId: rpf, sequence: 2 }));

  const h = (
    await bd.pool.query(`SELECT * FROM ${ESQUEMA}.case_header WHERE rpf_id=$1`, [rpf])
  ).rows[0];
  assert.equal(Number(h.eventos), 4);
  assert.equal(Number(h.sequence_min), 1);
  assert.equal(Number(h.sequence_max), 3, 'sequence_max retrocedio al reprocesar');
});

test('G-05 · un hueco de sequence se detecta', async () => {
  const rpf = randomUUID();
  for (const seq of [1, 2, 5]) {
    await inbox.persistir(evento({ rpfId: rpf, sequence: seq }));
  }
  const huecos = await inbox.huecos();
  const mio = huecos.find((h) => h.rpf_id === rpf);
  assert.ok(mio, 'el hueco no se detecto');
  assert.deepEqual(mio.faltan, [3, 4]);
});

test('G-05 · una secuencia completa NO reporta hueco', async () => {
  const rpf = randomUUID();
  for (const seq of [1, 2, 3]) {
    await inbox.persistir(evento({ rpfId: rpf, sequence: seq }));
  }
  assert.ok(
    !(await inbox.huecos()).some((h) => h.rpf_id === rpf),
    'falso positivo: un hueco donde no lo hay es peor que no medir',
  );
});

test('G-07 · un descarte queda anotado aunque no haya inbox', async () => {
  await inbox.anotarDescarte({
    payloadHash: null,
    rpfId: null,
    messageId: 'msg-1',
    motivo: 'firma_invalida',
    alarma: true,
    detalle: 'la firma no verifica',
    bytesSobre: 100,
    recepciones: 1,
    aLaDlq: true,
    e7: new Date(),
  });
  const c = await inbox.conciliacion();
  assert.equal(c.descartes, 1);
  assert.equal(c.descartes_con_alarma, 1);
});

/**
 * G-08 · El volcado de expedientes: lo que C4 puede afirmar que llego.
 *
 * ⚠ POR QUE NO BASTA CON `huecos()` (G-05). Esa consulta compara el rango que
 * ve contra los valores que tiene dentro, y el rango lo definen los propios
 * datos que llegaron: si falta la CABEZA, el MIN se desplaza; si falta la
 * COLA, el MAX se desplaza; y si se perdio el expediente entero no hay ni fila
 * que agrupar. Los tres casos salen densos y la consulta calla.
 *
 * Este volcado no intenta decidir si falta algo — no puede saberlo. Solo dice
 * "esto tengo", en un formato que el manifiesto del orquestador pueda restar.
 */
test('expedientes() vuelca lo que llego, comprimido en rangos', async () => {
  const rpf = randomUUID();
  for (const s of [1, 2, 3, 5]) {
    await inbox.persistir(evento({ rpfId: rpf, sequence: s, payloadHash: `h-${rpf}-${s}` }));
  }

  const todos = await inbox.expedientes();
  const e = todos.find((x) => x.rpf_id === rpf);

  assert.ok(e, 'el expediente tiene que estar en el volcado');
  assert.deepEqual(e!.sequences, [[1, 3], [5, 5]]);
  assert.equal(e!.vistos, 4);
});

test('expedientes() cuenta los duplicados sin sumarlos a lo llegado', async () => {
  // Un duplicado es salud del sistema (regla 4): el mismo payload_hash otra
  // vez. Si se contara como un evento mas, la conciliacion veria mas eventos
  // llegados que emitidos y el residuo de P4 saldria negativo.
  const rpf = randomUUID();
  const ev = evento({ rpfId: rpf, sequence: 1, payloadHash: `dup-${rpf}` });
  await inbox.persistir(ev);
  await inbox.persistir(ev);
  await inbox.persistir(ev);

  const e = (await inbox.expedientes()).find((x) => x.rpf_id === rpf);
  assert.equal(e!.vistos, 1, 'un solo evento unico');
  assert.equal(e!.duplicados, 2);
  assert.deepEqual(e!.sequences, [[1, 1]]);
});

test('expedientes() acepta un corte temporal para no mezclar corridas', async () => {
  // La base de C4 sobrevive a la corrida. Sin corte, el volcado traeria
  // expedientes de pruebas anteriores y la conciliacion los reportaria como
  // "desconocidos" por centenares.
  const futuro = new Date(Date.now() + 60_000).toISOString();
  assert.deepEqual(await inbox.expedientes(futuro), []);
});
