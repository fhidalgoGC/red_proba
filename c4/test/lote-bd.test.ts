/**
 * `persistirLote` contra un Postgres de verdad.
 *
 * ⚠ POR QUE CONTRA LA BASE Y NO CON UN DOBLE. Lo que puede romperse aqui son
 * cosas que solo dice Postgres:
 *
 *   · `ON CONFLICT DO UPDATE command cannot affect row a second time`, que es
 *     el motivo entero de que exista la pre-agregacion;
 *   · `could not determine data type of parameter`, si falta el cast de la
 *     primera fila del multifila;
 *   · `bind message supplies N parameters`, si la numeracion se desfasa.
 *
 * Ninguna de las tres la detecta un test con un cliente falso: las tres
 * aparecen la primera vez que el SQL toca un servidor.
 *
 * Y sobre todo: el lote tiene que dejar la base EXACTAMENTE igual que
 * persistir de a uno. Eso es lo que se comprueba al final.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { BdService } from '../src/bd/bd.service';
import { InboxRepository, type EventoAPersistir } from '../src/bd/inbox.repository';
import { ConfigService } from '../src/config/config.service';
import { BD, COLA } from './entorno';

const ESQUEMA = 'c4_test_lote';

let bd: BdService;
let inbox: InboxRepository;

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
    prueba: 'lote',
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

const n = async (sql: string) => Number((await bd.pool.query(sql)).rows[0].n);

before(async () => {
  process.env.SQS_QUEUE_URL = COLA;
  process.env.DATABASE_URL = BD;
  process.env.C4_ESQUEMA = ESQUEMA;
  const c = new ConfigService();
  bd = new BdService(c);
  await bd.pool.query(`DROP SCHEMA IF EXISTS ${ESQUEMA} CASCADE`);
  await bd.onApplicationBootstrap();
  inbox = new InboxRepository(bd, c);
});

after(async () => {
  await bd.pool.query(`DROP SCHEMA IF EXISTS ${ESQUEMA} CASCADE`);
  await bd.onApplicationShutdown();
});

// ---------------------------------------------------------------------------

test('un lote de 10 con la MISMA llave no revienta el ON CONFLICT', async () => {
  // Es el caso normal, no el raro: todos los mensajes de un lote vienen
  // firmados con la misma llave. Sin pre-agregar, esta sentencia falla entera
  // con "cannot affect row a second time".
  const lote = Array.from({ length: 10 }, () => evento());
  const r = await inbox.persistirLote(lote);

  assert.equal(r.size, 10);
  assert.equal([...r.values()].filter(Boolean).length, 10, 'alguna fila no se conto como nueva');
  assert.equal(await n(`SELECT COUNT(*) n FROM ${ESQUEMA}.inbox`), 10);
  assert.equal(await n(`SELECT COUNT(*) n FROM ${ESQUEMA}.journal`), 10);

  // Una sola fila de llave, con el total del lote.
  assert.equal(await n(`SELECT COUNT(*) n FROM ${ESQUEMA}.key_registry`), 1);
  assert.equal(
    await n(`SELECT eventos n FROM ${ESQUEMA}.key_registry`),
    10,
    'el contador de la llave no acumulo el lote entero',
  );
  // Y una sola de politica, por la misma razon.
  assert.equal(await n(`SELECT eventos n FROM ${ESQUEMA}.policy_registry`), 10);
});

test('varios eventos del MISMO expediente se funden en una cabecera', async () => {
  const rpf = randomUUID();
  const base = new Date('2026-08-31T10:00:00.000Z');
  const lote = [1, 2, 3].map((s) =>
    evento({
      rpfId: rpf,
      sequence: s,
      occurredAt: new Date(base.getTime() + s * 1000).toISOString(),
      eventType: s === 3 ? 'fiscal.document.cancelled' : 'fiscal.document.issued',
    }),
  );

  await inbox.persistirLote(lote);

  const h = (
    await bd.pool.query(
      `SELECT eventos, sequence_min, sequence_max, ultimo_tipo,
              primer_evento, ultimo_evento
         FROM ${ESQUEMA}.case_header WHERE rpf_id = $1`,
      [rpf],
    )
  ).rows[0];

  assert.equal(Number(h.eventos), 3);
  assert.equal(Number(h.sequence_min), 1);
  assert.equal(Number(h.sequence_max), 3);
  assert.equal(h.ultimo_tipo, 'fiscal.document.cancelled', 'el tipo no salio del sequence mayor');
  assert.equal(new Date(h.primer_evento).toISOString(), '2026-08-31T10:00:01.000Z');
  assert.equal(new Date(h.ultimo_evento).toISOString(), '2026-08-31T10:00:03.000Z');
});

test('un lote que repite un payload_hash lo cuenta como duplicado, no como dos', async () => {
  const ev = evento();
  // El mismo evento tres veces en la misma respuesta de SQS.
  const r = await inbox.persistirLote([ev, ev, ev]);

  assert.equal(r.get(ev.payloadHash), true, 'la primera copia tiene que ser nueva');
  assert.equal(
    await n(`SELECT COUNT(*) n FROM ${ESQUEMA}.journal WHERE payload_hash = '${ev.payloadHash}'`),
    1,
    'el libro se escribio mas de una vez para el mismo evento',
  );
  const f = (
    await bd.pool.query(
      `SELECT duplicados, recepciones FROM ${ESQUEMA}.inbox WHERE payload_hash = $1`,
      [ev.payloadHash],
    )
  ).rows[0];
  assert.equal(Number(f.duplicados), 2, 'las dos copias extra no se contaron como duplicados');
});

test('un lote que ya estaba entero no reescribe el libro', async () => {
  const lote = Array.from({ length: 4 }, () => evento());
  await inbox.persistirLote(lote);
  const journalAntes = await n(`SELECT COUNT(*) n FROM ${ESQUEMA}.journal`);

  const r = await inbox.persistirLote(lote);
  assert.equal([...r.values()].filter(Boolean).length, 0, 'un duplicado se colo como nuevo');
  assert.equal(await n(`SELECT COUNT(*) n FROM ${ESQUEMA}.journal`), journalAntes);
});

test('un lote mitad nuevo mitad repetido separa bien las dos mitades', async () => {
  const viejos = Array.from({ length: 3 }, () => evento());
  await inbox.persistirLote(viejos);

  const nuevos = Array.from({ length: 3 }, () => evento());
  const r = await inbox.persistirLote([...viejos, ...nuevos]);

  for (const v of viejos) assert.equal(r.get(v.payloadHash), false);
  for (const nv of nuevos) assert.equal(r.get(nv.payloadHash), true);
});

test('el lote deja la base IGUAL que persistir de a uno', async () => {
  // La prueba que de verdad importa: dos caminos, mismo resultado. Se comparan
  // los contadores acumulados de las proyecciones, que es donde una
  // agregacion mal hecha se nota.
  const party = 'hmac:' + 'a'.repeat(64);
  const llave = 'arn:aws:kms:us-west-2:1:key/comparativa';
  const construir = () =>
    Array.from({ length: 6 }, (_, i) =>
      // Sin `rpfId`: cada uno abre su expediente. Pasarlo como `undefined`
      // NO es lo mismo — el spread del final lo escribiria encima del valor
      // calculado y la columna saldria nula.
      evento({ partyId: party, keyId: llave, sequence: (i % 3) + 1 }),
    );

  const unoAUno = construir();
  for (const ev of unoAUno) await inbox.persistir(ev);

  const antes = (
    await bd.pool.query(
      `SELECT (SELECT eventos FROM ${ESQUEMA}.key_registry WHERE key_id = $1) k,
              (SELECT SUM(eventos) FROM ${ESQUEMA}.shared_map WHERE party_id = $2) s`,
      [llave, party],
    )
  ).rows[0];

  const enLote = construir();
  await inbox.persistirLote(enLote);

  const despues = (
    await bd.pool.query(
      `SELECT (SELECT eventos FROM ${ESQUEMA}.key_registry WHERE key_id = $1) k,
              (SELECT SUM(eventos) FROM ${ESQUEMA}.shared_map WHERE party_id = $2) s`,
      [llave, party],
    )
  ).rows[0];

  assert.equal(Number(despues.k) - Number(antes.k), 6, 'key_registry no sumo los 6 del lote');
  assert.equal(Number(despues.s) - Number(antes.s), 6, 'shared_map no sumo los 6 del lote');
});

test('shared_map cuenta expediente solo en el evento que lo abre, tambien en lote', async () => {
  const party = 'hmac:' + 'b'.repeat(64);
  const cnpj = '99888777000166';
  const rpf = randomUUID();
  const lote = [1, 2, 3].map((s) =>
    evento({
      rpfId: rpf,
      sequence: s,
      partyId: party,
      payload: {
        rpf_id: rpf,
        sequence: s,
        counterparty: { cnpj, uf: 'RJ' },
        document: { access_key: '2'.repeat(44) },
        totals: { products: '10.00' },
      },
    }),
  );

  await inbox.persistirLote(lote);

  const f = (
    await bd.pool.query(
      `SELECT expedientes, eventos FROM ${ESQUEMA}.shared_map
        WHERE party_id = $1 AND counterparty_cnpj = $2`,
      [party, cnpj],
    )
  ).rows[0];

  assert.equal(Number(f.eventos), 3);
  assert.equal(Number(f.expedientes), 1, 'expedientes se convirtio en una copia de eventos');
});

test('un lote vacio no toca la base ni lanza', async () => {
  const antes = await n(`SELECT COUNT(*) n FROM ${ESQUEMA}.inbox`);
  const r = await inbox.persistirLote([]);
  assert.equal(r.size, 0);
  assert.equal(await n(`SELECT COUNT(*) n FROM ${ESQUEMA}.inbox`), antes);
});
