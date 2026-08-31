/**
 * El pipeline entero: mapper -> firma -> cifrado.
 *
 * Corre en MODO LOCAL para la cripto (sin KMS) pero con POSTGRES DE VERDAD:
 * C-05 es una escritura transaccional, y probarla contra un doble no probaria
 * nada de lo que puede fallar. Crea su propio esquema y lo tira al terminar.
 *
 *     docker start cw-postgres     # 127.0.0.1:5433
 *
 * Lo que prueba no es KMS —eso solo se prueba contra KMS— sino las cosas que
 * se pueden romper sin que KMS se entere:
 *
 *  1. que la firma cubre EL CANONICO, con la misma convencion con la que C4
 *     verifica: `verify(null, canonicalize(payload), pub, firma)`. Si C3
 *     firmara un digest, o firmara el objeto re-serializado en vez del
 *     canonico, aqui se ve; en produccion se veria como `firma_invalida` en
 *     la DLQ de otra cuenta.
 *  2. que el sobre que sale se abre con `abrir()`, que es literalmente la
 *     funcion que C4 ejecuta.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Pool } from 'pg';
import { verify } from 'node:crypto';
import { abrir, parsearSobre } from '../src/comun/sobre';
import { canonicalize } from '../src/comun/jcs';
import { ConfigService } from '../src/config/config.service';
import { CifradorService } from '../src/cripto/cifrador.service';
import { FirmadorService } from '../src/cripto/firmador.service';
import { PseudonimoService } from '../src/cripto/pseudonimo.service';
import { BdService } from '../src/bd/bd.service';
import { OutboxRepository } from '../src/bd/outbox.repository';
import { MapperService } from '../src/mapper/mapper.service';
import { PARTY_ID_LARGO } from '../src/mapper/contrato';
import { PipelineService } from '../src/pipeline/pipeline.service';

const VALIDO = JSON.parse(
  readFileSync(join(process.cwd(), 'test', 'vectores', 'documento-valido.json'), 'utf8'),
) as Record<string, unknown>;

const clon = (): Record<string, unknown> => JSON.parse(JSON.stringify(VALIDO)) as Record<string, unknown>;

/** Un esquema propio por corrida: los tests no pisan datos de nadie. */
const ESQUEMA = 'c3_test';
const BD = process.env.DATABASE_URL ?? 'postgres://cw:cwlocal@127.0.0.1:5433/rpf_c4';

let config: ConfigService;
let bd: BdService;
let outbox: OutboxRepository;
let firmador: FirmadorService;
let cifrador: CifradorService;
let pseudonimo: PseudonimoService;
let pipeline: PipelineService;

before(async () => {
  // Sin llaves de KMS => modo local. Las tres o ninguna: la config lo exige.
  delete process.env.KMS_SIGN_KEY_ID;
  delete process.env.KMS_HMAC_KEY_ID;
  delete process.env.KMS_ENCRYPT_KEY_ID;
  process.env.TENANT_ID = 'tenant-test';
  process.env.DATABASE_URL = BD;
  process.env.C3_ESQUEMA = ESQUEMA;
  // Obligatoria desde C-06 aunque estos tests no publiquen: la config exige
  // que exista una salida, y ese guardarrail es justamente lo que impide un
  // C3 que contesta 202 sin tener a donde entregar.
  process.env.SQS_QUEUE_URL =
    process.env.SQS_QUEUE_URL ?? 'https://sqs.us-west-2.amazonaws.com/000/no-se-usa.fifo';

  config = new ConfigService();
  bd = new BdService(config);
  await bd.pool.query(`DROP SCHEMA IF EXISTS ${ESQUEMA} CASCADE`);
  await bd.onApplicationBootstrap();
  outbox = new OutboxRepository(bd);
  pseudonimo = new PseudonimoService(config);
  await pseudonimo.onModuleInit();
  firmador = new FirmadorService(config);
  cifrador = new CifradorService(config);
  pipeline = new PipelineService(pseudonimo, new MapperService(), firmador, cifrador, outbox);
});

after(async () => {
  await bd.pool.query(`DROP SCHEMA IF EXISTS ${ESQUEMA} CASCADE`);
  firmador.onApplicationShutdown();
  cifrador.onApplicationShutdown();
  pseudonimo.onApplicationShutdown();
  await bd.onApplicationShutdown();
});

test('sin llaves de KMS se entra en modo local, no a medias', () => {
  assert.equal(config.modoLocal, true);
});

test('el party_id mide exactamente lo que el contrato fija', () => {
  assert.equal(pseudonimo.partyId.length, PARTY_ID_LARGO);
  assert.match(pseudonimo.partyId, /^hmac:[0-9a-f]{64}$/);
});

test('el mismo tenant da siempre el mismo party_id', async () => {
  // Si cambiara entre arranques, el mismo documento daria dos payload_hash
  // distintos y C4 lo contaria dos veces.
  const otro = new PseudonimoService(config);
  await otro.onModuleInit();
  assert.equal(otro.partyId, pseudonimo.partyId);
  otro.onApplicationShutdown();
});

test('un documento valido recorre el pipeline entero', async () => {
  const r = await pipeline.procesar([clon()]);
  assert.equal(r.descartados.length, 0);
  assert.equal(r.procesados.length, 1);

  const p = r.procesados[0]!;
  assert.equal(p.bytesCanonicos, 3072);
  assert.match(p.payloadHash, /^[0-9a-f]{64}$/);
  assert.equal(p.rpfId, VALIDO['rpf_id']);
  // El sobre pesa mas que el canonico: firma, IV, tag, edk y el ~33% de base64.
  assert.ok(p.bytesSobre > p.bytesCanonicos, `${p.bytesSobre} deberia superar ${p.bytesCanonicos}`);
  // Y con margen de sobra bajo el limite de 256 KB de SQS.
  assert.ok(p.bytesSobre < 256 * 1024);
});

test('las marcas e0..e3 salen en orden y NO estan dentro del payload', async () => {
  const r = await pipeline.procesar([clon()]);
  const { marcas, sobre } = r.procesados[0]!;
  const t = (s: string) => Date.parse(s);
  assert.ok(t(marcas.e0) <= t(marcas.e1));
  assert.ok(t(marcas.e1) <= t(marcas.e2));
  assert.ok(t(marcas.e2) <= t(marcas.e3));

  // Regla 8: el payload va firmado, meterle metadatos de medicion cambiaria
  // lo que se firma. Se comprueba sobre el payload YA DESCIFRADO.
  const contenido = abrir(sobre, dataKeyDe(cifrador));
  for (const clave of ['e0', 'e1', 'e2', 'e3', 'recibido_en', 'timestamp']) {
    assert.equal(contenido.payload[clave], undefined, `el payload no puede traer '${clave}'`);
  }
});

test('la firma cubre el canonico, con la convencion con la que C4 verifica', async () => {
  const r = await pipeline.procesar([clon()]);
  const { sobre } = r.procesados[0]!;

  const contenido = abrir(sobre, dataKeyDe(cifrador));
  const publica = firmador.publicaLocal()!;

  // Exactamente la linea de c4/src/cripto/verificador.service.ts.
  const canonico = Buffer.from(canonicalize(contenido.payload), 'utf8');
  const ok = verify(null, canonico, publica, Buffer.from(contenido.signature, 'base64'));
  assert.ok(ok, 'la firma no verifica contra el canonico del payload descifrado');
});

test('tocar un byte del payload invalida la firma', async () => {
  const r = await pipeline.procesar([clon()]);
  const contenido = abrir(r.procesados[0]!.sobre, dataKeyDe(cifrador));
  const manipulado = { ...contenido.payload, sequence: (contenido.payload['sequence'] as number) + 1 };
  const ok = verify(
    null,
    Buffer.from(canonicalize(manipulado), 'utf8'),
    firmador.publicaLocal()!,
    Buffer.from(contenido.signature, 'base64'),
  );
  assert.equal(ok, false);
});

test('el sobre tiene la forma que C4 exige', async () => {
  const r = await pipeline.procesar([clon()]);
  // `parsearSobre` es la guarda que C4 corre ANTES de gastar un Decrypt.
  const sobre = parsearSobre(JSON.stringify(r.procesados[0]!.sobre));
  assert.equal(sobre.v, 1);
  assert.equal(sobre.alg, 'AES-256-GCM');
  assert.equal(sobre.sig_alg, 'Ed25519');
  assert.equal(Buffer.from(sobre.iv, 'base64').length, 12);
  assert.equal(Buffer.from(sobre.tag, 'base64').length, 16);
});

test('cada sobre lleva un IV distinto aunque comparta data key', async () => {
  // Reusar un IV con la misma clave en GCM rompe la confidencialidad. Es LA
  // razon por la que el payload_hash se calcula sobre el claro y no sobre el
  // sobre: dos cifrados del mismo evento dan bytes distintos.
  const r = await pipeline.procesar([clon(), clon()]);
  assert.notEqual(r.procesados[0]!.sobre.iv, r.procesados[1]!.sobre.iv);
  assert.notEqual(r.procesados[0]!.sobre.ct, r.procesados[1]!.sobre.ct);
  // ...y el mismo documento da el mismo payload_hash, que es lo que hace que SQS
  // FIFO pueda descartar el duplicado.
  assert.equal(r.procesados[0]!.payloadHash, r.procesados[1]!.payloadHash);
});

test('la data key se reusa: una GenerateDataKey, N sobres', async () => {
  const antes = { ...cifrador.contadores };
  const lote = Array.from({ length: 5 }, clon);
  await pipeline.procesar(lote);
  assert.equal(cifrador.contadores.cifrados - antes.cifrados, 5);
  // 5 sobres no pueden haber costado 5 data keys.
  assert.ok(
    cifrador.contadores.reusos > antes.reusos,
    'la data key no se esta reusando: seria una llamada a KMS por evento',
  );
});

test('un documento malo no se lleva por delante a los buenos', async () => {
  const malo = clon();
  (malo['totals'] as Record<string, unknown>)['icms'] = 2270.46; // number, no string

  const r = await pipeline.procesar([clon(), malo, clon()]);
  assert.equal(r.procesados.length, 2);
  assert.equal(r.descartados.length, 1);

  const d = r.descartados[0]!;
  assert.equal(d.motivo, 'importe_no_es_string');
  assert.equal(d.campo, 'totals.icms');
  assert.equal(d.indice, 1);
  // Con el event_id, un descarte es rastreable hasta el orquestador.
  assert.equal(d.eventId, VALIDO['event_id']);
});

test('lo descartado no se firma ni se cifra', async () => {
  const antes = { ...firmador.contadores };
  const malo = clon();
  delete (malo['document'] as Record<string, unknown>)['access_key'];
  await pipeline.procesar([malo]);
  assert.equal(firmador.contadores.firmadas, antes.firmadas);
});

/**
 * La data key en claro que el cifrador tiene vigente. Solo para los tests:
 * en produccion la abre C4 tras un `Decrypt`, y esa es toda la separacion.
 */
function dataKeyDe(c: CifradorService): Buffer {
  const v = (c as unknown as { vigente: { clara: Buffer } | null }).vigente;
  assert.ok(v, 'no hay data key vigente');
  return v.clara;
}

// ─────────────────────────────────────────────────────────────────────────────
// C-05 · el outbox. Es la única fuente de lo que llega a C4: lo que no quede
// en esa tabla no se publica y no existe.
// ─────────────────────────────────────────────────────────────────────────────

test('C-05 · lo procesado queda en el outbox, PENDING y con su sobre', async () => {
  const r = await pipeline.procesar([clon()]);
  const p = r.procesados[0]!;
  assert.ok(p.outboxId, 'sin id de outbox, la fila no se escribió');

  const { rows } = await bd.pool.query(
    `SELECT rpf_id, payload_hash, status, attempts, envelope, sent_at
       FROM ${ESQUEMA}.outbox WHERE id = $1`,
    [p.outboxId],
  );
  const fila = rows[0]!;
  assert.equal(fila.status, 'PENDING');
  assert.equal(fila.attempts, 0);
  assert.equal(fila.sent_at, null, 'nada se publica en C-05');
  assert.equal(fila.payload_hash, p.payloadHash);
  assert.equal(fila.rpf_id, p.rpfId);
  // El sobre guardado es EL que iba a viajar, no una reconstrucción.
  assert.deepEqual(fila.envelope, p.sobre);
});

test('C-05 · el outbox y el expediente comparten transacción (regla 2)', async () => {
  const doc = clon();
  const rpf = '11111111-1111-4111-8111-111111111111';
  doc['rpf_id'] = rpf;
  await pipeline.procesar([doc]);

  const exp = await bd.pool.query(
    `SELECT eventos FROM ${ESQUEMA}.expediente WHERE rpf_id = $1`, [rpf]);
  const out = await bd.pool.query(
    `SELECT count(*)::int n FROM ${ESQUEMA}.outbox WHERE rpf_id = $1`, [rpf]);
  // Si fueran dos escrituras separadas, esto se desincroniza en el primer
  // fallo entre una y otra. Con una transacción, o están las dos o ninguna.
  assert.equal(exp.rows[0]!.eventos, out.rows[0]!.n);
});

test('C-05 · un lote entero cae en UNA transacción, no en N', async () => {
  const antes = { ...outbox.contadores };
  await pipeline.procesar([clon(), clon(), clon()]);
  assert.equal(outbox.contadores.transacciones - antes.transacciones, 1);
  assert.equal(outbox.contadores.filas - antes.filas, 3);
});

test('C-05 · e0..e4 quedan en columnas y en orden', async () => {
  const r = await pipeline.procesar([clon()]);
  const p = r.procesados[0]!;
  assert.ok(p.marcas.e4, 'e4 lo pone la base, en el INSERT');

  const { rows } = await bd.pool.query(
    `SELECT e0_listo, e1_canonizado, e2_firmado, e3_cifrado, e4_commit,
            e5_reclamado, e6_publicado
       FROM ${ESQUEMA}.outbox WHERE id = $1`,
    [p.outboxId],
  );
  const f = rows[0]!;
  const t = (d: Date) => d.getTime();
  assert.ok(t(f.e0_listo) <= t(f.e1_canonizado));
  assert.ok(t(f.e1_canonizado) <= t(f.e2_firmado));
  assert.ok(t(f.e2_firmado) <= t(f.e3_cifrado));
  assert.ok(t(f.e3_cifrado) <= t(f.e4_commit));
  // e5 y e6 son del relay, que no existe.
  assert.equal(f.e5_reclamado, null);
  assert.equal(f.e6_publicado, null);
});

test('C-05 · las marcas NO están dentro del payload firmado (regla 8)', async () => {
  const r = await pipeline.procesar([clon()]);
  const { rows } = await bd.pool.query(
    `SELECT envelope FROM ${ESQUEMA}.outbox WHERE id = $1`, [r.procesados[0]!.outboxId]);
  // El sobre es opaco, pero lo abrimos para comprobar que nadie coló una marca.
  const contenido = abrir(rows[0]!.envelope, dataKeyDe(cifrador));
  for (const k of ['e0', 'e1', 'e2', 'e3', 'e4', 'e4_commit']) {
    assert.equal(contenido.payload[k], undefined, `el payload no puede traer '${k}'`);
  }
});

test('C-05 · varios eventos del mismo expediente acumulan sin desordenarse', async () => {
  const rpf = '22222222-2222-4222-8222-222222222222';
  const docs = [5, 2, 9].map((seq) => {
    const d = clon(); d['rpf_id'] = rpf; d['sequence'] = seq; return d;
  });
  await pipeline.procesar(docs);

  const { rows } = await bd.pool.query(
    `SELECT eventos, sequence_min, sequence_max FROM ${ESQUEMA}.expediente WHERE rpf_id = $1`,
    [rpf]);
  const e = rows[0]!;
  assert.equal(e.eventos, 3);
  // GREATEST/LEAST y no asignación: los eventos llegan desordenados porque el
  // orquestador dispara sin esperar respuesta (O-02).
  assert.equal(e.sequence_min, 2);
  assert.equal(e.sequence_max, 9);
});

test('C-05 · lo descartado NO llega al outbox', async () => {
  const malo = clon();
  (malo['totals'] as Record<string, unknown>)['icms'] = 2270.46;
  const antes = (await bd.pool.query(`SELECT count(*)::int n FROM ${ESQUEMA}.outbox`)).rows[0]!.n;

  const r = await pipeline.procesar([malo]);
  assert.equal(r.descartados.length, 1);
  assert.equal(r.procesados.length, 0);

  const despues = (await bd.pool.query(`SELECT count(*)::int n FROM ${ESQUEMA}.outbox`)).rows[0]!.n;
  assert.equal(despues, antes, 'un documento rechazado no puede dejar fila');
});
