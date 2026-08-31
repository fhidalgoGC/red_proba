/**
 * Punta a punta REAL: KMS de verdad, cola FIFO de verdad, Postgres de verdad.
 *
 *   productor (hace de C3) → SQS FIFO → C4 → Postgres
 *
 * Nada esta simulado. La firma la hace la llave Ed25519 de la PoC, el cifrado
 * usa una data key de la llave simetrica de C4, y los mensajes viajan por la
 * cola que creo terraform. Lo unico que no es el de produccion es el Postgres,
 * que aqui es un contenedor local con su propio esquema.
 *
 *   npm run e2e            corrida rapida
 *   npm run e2e -- --lento incluye la reentrega real de SQS (~90 s)
 */
import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import {
  DeleteMessageBatchCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { Pool } from 'pg';
import { canonicalize } from '../src/comun/jcs';
import { payloadHash, sellar, type Sobre } from '../src/comun/sobre';
import { documento, prng, Productor, type Publicado } from './productor';
import { BD, COLA, DLQ, LLAVE_CIFRADO, LLAVE_FIRMA, REGION } from './entorno';

const ESQUEMA = 'c4_e2e';
const LENTO = process.argv.includes('--lento');

/**
 * El id de corrida. Viaja en el `MessageAttribute` `prueba` igual que lo pone
 * el relay de C3, y es lo que hace que C4 escriba `<PRUEBA>__c4.json` en vez
 * de mezclarlo todo en `sin-id`. Fijo y no aleatorio: asi el archivo de la
 * ultima corrida siempre esta en el mismo sitio para mirarlo a mano.
 */
const PRUEBA = 'e2e';

const RPFS = 3;
const POR_RPF = 4;
const LEGITIMOS = RPFS * POR_RPF;

interface CasoVeneno {
  nombre: string;
  motivoEsperado: string;
  sobre: Sobre | Record<string, unknown>;
  rpfId: string;
  payloadHash: string;
}

async function main(): Promise<void> {
  console.log(`\n── punta a punta ${LENTO ? '(con reentrega real)' : '(rapida)'} ──`);
  console.log(`cola     ${COLA}`);
  console.log(`firma    ${LLAVE_FIRMA.slice(-36)}`);
  console.log(`base     ${BD.replace(/:\/\/[^@]*@/, '://***@')} · esquema ${ESQUEMA}\n`);

  const sqs = new SQSClient({ region: REGION });
  const pool = new Pool({ connectionString: BD });

  // ── Punto de partida limpio ──
  // La cola es real y compartida: si quedaron mensajes de una corrida
  // anterior, los contadores de esta mezclarian dos pruebas y el resultado no
  // significaria nada.
  const sobrantes = await vaciarCola(sqs, COLA);
  if (sobrantes > 0) console.log(`⚠ habia ${sobrantes} mensajes viejos en la cola, drenados`);
  await pool.query(`DROP SCHEMA IF EXISTS ${ESQUEMA} CASCADE`);

  const productor = new Productor({
    region: REGION,
    colaUrl: COLA,
    llaveFirma: LLAVE_FIRMA,
    llaveCifrado: LLAVE_CIFRADO,
  });

  // ── 1. Documentos legitimos ──
  const r = prng(20260830);
  const partyId = 'hmac:' + 'a1b2c3d4'.repeat(8);
  const legitimos: Publicado[] = [];

  const t0 = Date.now();
  for (let i = 0; i < RPFS; i++) {
    const rpfId = randomUUID();
    for (let seq = 1; seq <= POR_RPF; seq++) {
      // Tamanos sorteados en [2048, 4096], no todos iguales: con tamano unico
      // eventos/s y MB/s son la misma metrica y P3 no puede distinguir un
      // limite por operacion de uno por byte.
      const tamano = 2048 + Math.floor(r() * (4096 - 2048));
      legitimos.push(await productor.preparar(documento(r, rpfId, seq, tamano, partyId)));
    }
  }
  const msFirma = Date.now() - t0;
  console.log(
    `${LEGITIMOS} documentos firmados y cifrados en ${msFirma} ms ` +
      `(${Math.round(msFirma / LEGITIMOS)} ms/evento · ${productor.contadores.sign} Sign, ` +
      `${productor.contadores.generate_data_key} GenerateDataKey)`,
  );
  const bytes = legitimos.map((p) => p.bytesCanonicos);
  console.log(
    `canonicos ${Math.min(...bytes)}..${Math.max(...bytes)} B · ` +
      `sobres ${Math.min(...legitimos.map((p) => p.bytesSobre))}..` +
      `${Math.max(...legitimos.map((p) => p.bytesSobre))} B\n`,
  );

  // ── 2. Los venenos de G-07 ──
  const venenos = await construirVenenos(productor, r, partyId);

  // ── 3. Publicar ──
  const envio = await productor.publicar(
    [
      ...legitimos.map((p) => ({ sobre: p.sobre, rpfId: p.rpfId, payloadHash: p.payloadHash })),
      ...venenos.map((v) => ({ sobre: v.sobre as Sobre, rpfId: v.rpfId, payloadHash: v.payloadHash })),
    ],
    PRUEBA,
  );
  console.log(
    `publicados ${envio.ok} mensajes (${LEGITIMOS} legitimos + ${venenos.length} venenos), ` +
      `${envio.fallidos} fallidos\n`,
  );
  assert.equal(envio.fallidos, 0, 'SQS rechazo mensajes: la corrida no vale');
  productor.cerrar();

  // ── 4. Correr C4 de verdad ──
  const app = await arrancarC4();
  const consumidor = app.get(
    (await import('../src/consumidor/consumidor.service')).ConsumidorService,
  );
  const procesador = app.get(
    (await import('../src/consumidor/procesador.service')).ProcesadorService,
  );
  const t1 = Date.now();
  await consumidor.terminado;
  const msConsumo = Date.now() - t1;

  const inbox = app.get((await import('../src/bd/inbox.repository')).InboxRepository);
  // Filtrado por la corrida, que es como se corre de verdad: la base sobrevive
  // a la prueba y sin corte el conteo arrastraria las anteriores.
  const conc = await inbox.conciliacion(PRUEBA);
  const huecos = await inbox.huecos();

  // G-11 · el informe por segundo, antes de cerrar la app. `app.close()` es lo
  // que dispara el volcado final (el mismo camino que SIGTERM en Fargate).
  const registro = app.get((await import('../src/metricas/registro.service')).RegistroService);
  const logC4 = registro.ruta(PRUEBA);
  await app.close();

  // ── 5. Lo que tiene que ser cierto ──
  console.log(`\n── resultado (consumo ${msConsumo} ms) ──`);
  console.table(conc);

  const fallos: string[] = [];
  const comprobar = (cond: boolean, texto: string) => {
    console.log(`${cond ? '✔' : '✖'} ${texto}`);
    if (!cond) fallos.push(texto);
  };

  comprobar(conc.inbox === LEGITIMOS, `P4 · llegaron los ${LEGITIMOS} legitimos (inbox=${conc.inbox})`);
  comprobar(
    conc.journal_total === LEGITIMOS,
    `el journal tiene ${LEGITIMOS} asientos (${conc.journal_total})`,
  );
  comprobar(conc.sin_e10 === 0, `todos tienen e10 (sin_e10=${conc.sin_e10})`);
  comprobar(
    conc.expedientes_total === RPFS,
    `${RPFS} expedientes en case_header (${conc.expedientes_total})`,
  );
  comprobar(huecos.length === 0, `G-05 · sin huecos de sequence (${huecos.length})`);

  // ── G-11 · el reloj de C4, por segundo ──
  //
  // Lo que se comprueba no es que el archivo exista: es que el id de corrida
  // llego hasta aqui DENTRO del MessageAttribute y que los tramos cuadran. Si
  // el atributo no viajara, todo esto habria caido en `sin-id` y el archivo
  // que se busca no estaria.
  let log: any = null;
  try {
    log = JSON.parse(readFileSync(logC4, 'utf8'));
  } catch { /* el comprobar de abajo lo declara */ }
  comprobar(log !== null, `G-11 · el log por segundo esta en ${logC4}`);
  if (log) {
    const m = log.total.messages;
    comprobar(
      m.persisted === LEGITIMOS,
      `G-11 · el log cuenta los ${LEGITIMOS} persistidos (${m.persisted})`,
    );
    comprobar(
      m.discarded === venenos.length,
      `G-11 · y los ${venenos.length} descartados (${m.discarded})`,
    );
    // La aritmetica que hace util el desglose: los cinco tramos del mensaje
    // suman el mensaje. Se compara con tolerancia porque entre `hash` y
    // `inbox` hay unos microsegundos de armado de parametros que no pertenecen
    // a ningun tramo.
    const s = m.steps;
    const piezas = ['envelope', 'decrypt', 'verify', 'hash', 'inbox']
      .reduce((n, k) => n + (s[k]?.suma_ms ?? 0), 0);
    const entero = s.message?.suma_ms ?? 0;
    const desvio = entero === 0 ? 1 : Math.abs(entero - piezas) / entero;
    comprobar(
      desvio < 0.05,
      `G-11 · envelope+decrypt+verify+hash+inbox = message ` +
        `(${piezas.toFixed(1)} vs ${entero.toFixed(1)} ms, ${(desvio * 100).toFixed(2)}%)`,
    );
    // `wait` NO entra en esa suma: es lo que el mensaje espero su turno dentro
    // del lote, no trabajo. Sumarlo contaria dos veces el procesamiento de los
    // anteriores (04-medicion).
    comprobar(
      (s.wait?.init ?? 0) === LEGITIMOS + venenos.length,
      `G-11 · wait se mide en los ${LEGITIMOS + venenos.length} mensajes, y va fuera de la suma`,
    );
  }
  comprobar(
    conc.descartes === venenos.length,
    `G-07 · ${venenos.length} descartes anotados (${conc.descartes})`,
  );
  comprobar(
    conc.descartes_con_alarma === venenos.length,
    `G-07 · los ${venenos.length} con alarma (${conc.descartes_con_alarma})`,
  );
  comprobar(
    procesador.contadores.persistidos === LEGITIMOS,
    `el procesador persistio ${LEGITIMOS} (${procesador.contadores.persistidos})`,
  );
  comprobar(
    procesador.contadores.reintentar === 0,
    `nada quedo para reintentar (${procesador.contadores.reintentar})`,
  );

  // Cada veneno tiene que haber sido rechazado POR SU MOTIVO. Que el total
  // cuadre no basta: dos venenos rechazados por el motivo equivocado darian
  // el mismo total y esconderian que una de las dos guardas no funciona.
  const motivos = await pool.query<{ motivo: string; n: string }>(
    `SELECT motivo, COUNT(*) n FROM ${ESQUEMA}.descartes GROUP BY motivo ORDER BY motivo`,
  );
  const porMotivo = new Map(motivos.rows.map((m) => [m.motivo, Number(m.n)]));
  console.log('\nmotivos de descarte:');
  for (const v of venenos) {
    const ok = (porMotivo.get(v.motivoEsperado) ?? 0) > 0;
    comprobar(ok, `  ${v.nombre} → ${v.motivoEsperado}`);
  }

  // La firma y el descifrado tienen que haber ocurrido de verdad.
  const cripto = await pool.query<{ n: string }>(
    `SELECT COUNT(*) n FROM ${ESQUEMA}.inbox WHERE e8_descifrado IS NOT NULL AND e9_verificado IS NOT NULL`,
  );
  comprobar(
    Number(cripto.rows[0]?.n ?? 0) === LEGITIMOS,
    `los ${LEGITIMOS} se descifraron Y se verificaron`,
  );

  // El payload guardado tiene que ser el que se firmo, no una version del
  // sobre. Se comprueba recanonizando y comparando con el original.
  const guardado = await pool.query<{ payload_hash: string; payload: Record<string, unknown> }>(
    `SELECT payload_hash, payload FROM ${ESQUEMA}.journal`,
  );
  const original = new Map(legitimos.map((p) => [p.payloadHash, p.payload]));
  const identicos = guardado.rows.filter(
    (g) => canonicalize(g.payload) === canonicalize(original.get(g.payload_hash) ?? {}),
  ).length;
  comprobar(
    identicos === LEGITIMOS,
    `el payload guardado es byte a byte el firmado (${identicos}/${LEGITIMOS})`,
  );

  // Latencias del tramo que le toca a C4.
  const lat = await pool.query<Record<string, string>>(
    `SELECT
       ROUND(AVG(EXTRACT(EPOCH FROM (e10_persistido - e7_recibido)) * 1000)::numeric, 1) AS e7_e10_medio,
       ROUND(MAX(EXTRACT(EPOCH FROM (e10_persistido - e7_recibido)) * 1000)::numeric, 1) AS e7_e10_max,
       ROUND(AVG(EXTRACT(EPOCH FROM (e7b_tomado - e7_recibido)) * 1000)::numeric, 1) AS espera_en_lote,
       ROUND(AVG(EXTRACT(EPOCH FROM (e8_descifrado - e7b_tomado)) * 1000)::numeric, 1) AS descifrado,
       ROUND(AVG(EXTRACT(EPOCH FROM (e9_verificado - e8_descifrado)) * 1000)::numeric, 1) AS verificacion,
       ROUND(AVG(EXTRACT(EPOCH FROM (e10_persistido - e9_verificado)) * 1000)::numeric, 1) AS persistencia,
       ROUND(AVG(EXTRACT(EPOCH FROM (e7_recibido - sqs_enviado)) * 1000)::numeric, 1) AS en_cola_aprox
     FROM ${ESQUEMA}.inbox`,
  );
  console.log('\ntramos de C4, en ms:');
  console.table(lat.rows[0]);

  // ── 6. Reentrega real de SQS ──
  if (LENTO) await probarReentrega(sqs, pool, comprobar);

  await pool.end();
  sqs.destroy();

  console.log('');
  if (fallos.length > 0) {
    console.error(`✖ ${fallos.length} comprobaciones fallaron:`);
    for (const f of fallos) console.error(`   · ${f}`);
    process.exit(1);
  }
  console.log('✔ punta a punta en verde');
}

/**
 * Los seis venenos de G-07. Cada uno ataca una guarda distinta, y cada uno
 * tiene que caer por SU motivo.
 */
async function construirVenenos(
  productor: Productor,
  r: () => number,
  partyId: string,
): Promise<CasoVeneno[]> {
  const dk = await productor.dataKeyVigente();
  const casos: CasoVeneno[] = [];

  // 1. Ni siquiera es un sobre. Solo C3 puede publicar en esta cola, asi que
  //    esto solo puede ser un error de configuracion o alguien mas.
  casos.push({
    nombre: 'el cuerpo no es un sobre',
    motivoEsperado: 'no_es_sobre',
    sobre: { hola: 'mundo' },
    rpfId: randomUUID(),
    payloadHash: 'veneno-no-sobre-' + randomUUID(),
  });

  // 2. Ciphertext manipulado: el tag de GCM no va a cuadrar.
  const p2 = await productor.preparar(documento(r, randomUUID(), 1, 2048, partyId));
  const ct = Buffer.from(p2.sobre.ct, 'base64');
  ct[10] = (ct[10] ?? 0) ^ 0xff;
  casos.push({
    nombre: 'ciphertext alterado',
    motivoEsperado: 'no_descifra',
    sobre: { ...p2.sobre, ct: ct.toString('base64') },
    rpfId: p2.rpfId,
    payloadHash: p2.payloadHash,
  });

  // 3. ⚠ El caso grave: descifra pero la firma no verifica. Es alguien con la
  //    llave de cifrado intentando inyectar un documento que nunca se firmo.
  const bueno = await productor.preparar(documento(r, randomUUID(), 1, 2176, partyId));
  const falso = documento(r, bueno.rpfId, 1, 2176, partyId);
  const sobreFalso = sellar(
    // La firma del documento legitimo, pegada a OTRO documento.
    { payload: falso, signature: (await productor.preparar(bueno.payload)).sobre.ct.slice(0, 88) },
    dk.clara,
    dk.cifrada,
    LLAVE_FIRMA,
  );
  casos.push({
    nombre: 'descifra pero la firma no cubre el documento',
    motivoEsperado: 'firma_invalida',
    sobre: sobreFalso,
    rpfId: String(falso.rpf_id),
    payloadHash: payloadHash(falso),
  });

  // 4. Firmado con otra llave: el key_id no esta en la lista blanca. La firma
  //    seria valida para ESA llave — por eso la lista blanca va primero.
  const p4 = await productor.preparar(documento(r, randomUUID(), 1, 2304, partyId));
  casos.push({
    nombre: 'key_id fuera de la lista blanca',
    motivoEsperado: 'llave_no_aceptada',
    sobre: { ...p4.sobre, key_id: 'arn:aws:kms:us-west-2:999:key/de-otro' },
    rpfId: p4.rpfId,
    payloadHash: p4.payloadHash,
  });

  // 5. El payload_hash declarado no es el del payload. Si C4 se lo creyera, la
  //    idempotencia quedaria en manos del emisor.
  const p5 = await productor.preparar(documento(r, randomUUID(), 1, 2432, partyId));
  casos.push({
    nombre: 'payload_hash declarado que no es el del payload',
    motivoEsperado: 'payload_hash_no_coincide',
    sobre: p5.sobre,
    rpfId: p5.rpfId,
    payloadHash: 'a'.repeat(64),
  });

  // 6. rpf_id que no es un UUID. Sin la guarda, Postgres rechaza la INSERT y
  //    el rechazo se leeria como fallo transitorio: reintento infinito.
  const malRpf = documento(r, randomUUID(), 1, 2560, partyId);
  malRpf.rpf_id = 'no-soy-un-uuid';
  const p6 = await productor.preparar(malRpf);
  casos.push({
    nombre: 'rpf_id que no es UUID',
    motivoEsperado: 'rpf_id_invalido',
    sobre: p6.sobre,
    // El grupo tiene que coincidir con el payload o caeria por otro motivo.
    rpfId: 'no-soy-un-uuid',
    payloadHash: p6.payloadHash,
  });

  return casos;
}

/**
 * La reentrega de verdad: se publica un evento, C4 lo procesa SIN borrarlo, y
 * al vencer el visibility timeout SQS lo devuelve. Es el unico modo de
 * comprobar que la idempotencia funciona sobre el camino real y no solo sobre
 * la llamada al repositorio.
 */
async function probarReentrega(
  sqs: SQSClient,
  pool: Pool,
  comprobar: (c: boolean, t: string) => void,
): Promise<void> {
  console.log('\n── reentrega real (esto tarda ~90 s: el visibility timeout son 60) ──');

  const productor = new Productor({
    region: REGION, colaUrl: COLA, llaveFirma: LLAVE_FIRMA, llaveCifrado: LLAVE_CIFRADO,
  });
  const r = prng(777);
  const p = await productor.preparar(
    documento(r, randomUUID(), 1, 2048, 'hmac:' + 'f'.repeat(64)),
  );
  await productor.publicar([{ sobre: p.sobre, rpfId: p.rpfId, payloadHash: p.payloadHash }]);
  productor.cerrar();

  // Primera pasada SIN borrar: el mensaje queda invisible 60 s y vuelve.
  process.env.C4_BORRAR = 'false';
  const a = await arrancarC4();
  await a.get((await import('../src/consumidor/consumidor.service')).ConsumidorService).terminado;
  await a.close();

  const tras1 = await pool.query<{ n: string; d: string }>(
    `SELECT COUNT(*) n, COALESCE(SUM(duplicados),0) d FROM ${ESQUEMA}.inbox WHERE payload_hash=$1`,
    [p.payloadHash],
  );
  comprobar(Number(tras1.rows[0]?.n ?? 0) === 1, '  reentrega · primera pasada persistio 1');

  console.log('  esperando a que venza el visibility timeout...');
  await new Promise((res) => setTimeout(res, 65_000));

  process.env.C4_BORRAR = 'true';
  const b = await arrancarC4();
  await b.get((await import('../src/consumidor/consumidor.service')).ConsumidorService).terminado;
  await b.close();

  const tras2 = await pool.query<{ n: string; d: string; j: string }>(
    `SELECT (SELECT COUNT(*) FROM ${ESQUEMA}.inbox WHERE payload_hash=$1) n,
            (SELECT COALESCE(SUM(duplicados),0) FROM ${ESQUEMA}.inbox WHERE payload_hash=$1) d,
            (SELECT COUNT(*) FROM ${ESQUEMA}.journal WHERE payload_hash=$1) j`,
    [p.payloadHash],
  );
  const f = tras2.rows[0] ?? { n: '0', d: '0', j: '0' };
  comprobar(Number(f.n) === 1, '  reentrega · sigue habiendo UNA fila de inbox');
  comprobar(Number(f.d) >= 1, `  reentrega · el duplicado se conto (duplicados=${f.d})`);
  comprobar(Number(f.j) === 1, '  reentrega · el journal NO duplico el asiento');
  await vaciarCola(sqs, COLA);
}

async function arrancarC4() {
  process.env.SQS_QUEUE_URL = COLA;
  process.env.SQS_DLQ_URL = DLQ;
  process.env.DATABASE_URL = BD;
  process.env.C4_ESQUEMA = ESQUEMA;
  process.env.AWS_REGION = REGION;
  process.env.KMS_ENCRYPT_KEY_ID = LLAVE_CIFRADO;
  // La lista blanca ACTIVA: sin ella, el veneno 4 pasaria la verificacion.
  process.env.C4_LLAVES_FIRMA = LLAVE_FIRMA;
  process.env.C4_SALIR_TRAS_VACIOS = '2';
  process.env.SQS_WAIT_SECONDS = '2';
  process.env.C4_RESUMEN_MS = '5000';

  const { AppModule } = await import('../src/app.module');
  return NestFactory.createApplicationContext(AppModule, { bufferLogs: false });
}

async function vaciarCola(sqs: SQSClient, url: string): Promise<number> {
  let n = 0;
  for (;;) {
    const r = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }),
    );
    const ms = r.Messages ?? [];
    if (ms.length === 0) return n;
    n += ms.length;
    await sqs.send(
      new DeleteMessageBatchCommand({
        QueueUrl: url,
        Entries: ms.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle as string })),
      }),
    );
  }
}

main().catch((e) => {
  console.error('\n✖ la corrida de punta a punta reviento:', e);
  process.exit(1);
});
