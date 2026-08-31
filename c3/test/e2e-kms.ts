/**
 * ¿Lo que cifra C3 lo puede abrir C4? — contra KMS REAL.
 *
 * Esta es la única prueba que responde esa pregunta. Todo lo demás en
 * `c3/test/` corre en modo local, con una Ed25519 del proceso: prueba que el
 * pipeline es coherente consigo mismo, no que interopera con C4.
 *
 * ⚠ NECESITA AWS. Credenciales con acceso a las llaves de la PoC. No corre en
 * `npm test` a propósito — un test que necesita red y cuesta dinero no debe
 * estar en el camino de todos los días.
 *
 *     npm run e2e:kms
 *
 * LO QUE PRUEBA:
 *   · que `KMS Sign` con ED25519_SHA_512 produce firmas que la verificación
 *     Ed25519 pura de C4 acepta — si C3 usara el algoritmo `_PH_`, o firmara
 *     un digest, aquí se rompe;
 *   · que la `edk` de `GenerateDataKey` la descifra un `Decrypt` y que la data
 *     key resultante abre el sobre;
 *   · que el `party_id` de `GenerateMac` mide lo que el contrato exige;
 *   · que el `payload_hash` que C3 declara es el que C4 recalcularía.
 *
 *   · y el CAMINO COMPLETO: el sobre se publica en la cola FIFO real, para que
 *     lo consuma el worker real de C4 y lo persista en Postgres. Ese último
 *     tramo no lo hace este archivo — lo hace `c4/dist/main.js` sin tocar.
 *
 * LO QUE NO PRUEBA, y hay que decirlo:
 *   · las POLICIES. Esto corre con las credenciales de quien lo lance; si son
 *     de administrador, `Decrypt` funciona aunque el rol de C3 no lo tenga.
 *     Que C3 no pueda descifrar (regla 7) lo sostienen las policies de KMS y
 *     solo se comprueba desplegado, con los roles de verdad.
 *   · el relay de C-06. La publicación de aquí es directa; falta el outbox, la
 *     transacción, el backoff y el circuit breaker.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPublicKey, randomUUID, verify } from 'node:crypto';
import { DecryptCommand, GetPublicKeyCommand, KMSClient } from '@aws-sdk/client-kms';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { canonicalize } from '../src/comun/jcs';
import { abrir, parsearSobre } from '../src/comun/sobre';
import { ConfigService } from '../src/config/config.service';
import { CifradorService } from '../src/cripto/cifrador.service';
import { FirmadorService } from '../src/cripto/firmador.service';
import { PseudonimoService } from '../src/cripto/pseudonimo.service';
import { PARTY_ID_LARGO } from '../src/mapper/contrato';
import { payloadHash } from '../src/mapper/hashing';
import { BdService } from '../src/bd/bd.service';
import { OutboxRepository } from '../src/bd/outbox.repository';
import { MapperService } from '../src/mapper/mapper.service';
import { PipelineService } from '../src/pipeline/pipeline.service';

/** Los ARN de `terraform/oneClient`. Se pueden pisar por entorno. */
const REGION = process.env.AWS_REGION ?? 'us-west-2';
const CUENTA = '276076558677';
const COLA =
  process.env.SQS_QUEUE_URL ?? `https://sqs.${REGION}.amazonaws.com/${CUENTA}/rpf-one-eventos.fifo`;
const LLAVES = {
  firma: process.env.KMS_SIGN_KEY_ID ?? `arn:aws:kms:${REGION}:${CUENTA}:key/9c2ba3c2-e111-463a-871f-c1ee048dbefa`,
  hmac: process.env.KMS_HMAC_KEY_ID ?? `arn:aws:kms:${REGION}:${CUENTA}:key/83695b89-189e-479d-800a-9bda424ecabd`,
  cifrado: process.env.KMS_ENCRYPT_KEY_ID ?? `arn:aws:kms:${REGION}:${CUENTA}:key/f8940502-057c-42b3-9a09-8d40cf673f68`,
};

const ok = (b: unknown, m: string): void => {
  console.log(`${b ? '  ✔' : '  ✘'} ${m}`);
  if (!b) process.exitCode = 1;
};

async function main(): Promise<void> {
  console.log('C3 → C4 contra KMS real\n');
  console.log(`  region ${REGION} · cuenta ${CUENTA}`);
  console.log(`  firma   ${LLAVES.firma.slice(-36)}`);
  console.log(`  hmac    ${LLAVES.hmac.slice(-36)}`);
  console.log(`  cifrado ${LLAVES.cifrado.slice(-36)}\n`);

  // ── 1 · C3, con las llaves de verdad ─────────────────────────────────────
  process.env.KMS_SIGN_KEY_ID = LLAVES.firma;
  process.env.KMS_HMAC_KEY_ID = LLAVES.hmac;
  process.env.KMS_ENCRYPT_KEY_ID = LLAVES.cifrado;
  process.env.TENANT_ID = process.env.TENANT_ID ?? 'tenant-01';
  // Base propia de C3. La de C4 la abre el worker de C4, no este proceso.
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? 'postgres://cw:cwlocal@127.0.0.1:5433/rpf_c3_test';

  const config = new ConfigService();
  assert.equal(config.modoLocal, false, 'con las tres llaves NO puede estar en modo local');

  const pseudonimo = new PseudonimoService(config);
  await pseudonimo.onModuleInit();
  const firmador = new FirmadorService(config);
  const cifrador = new CifradorService(config);
  const bd = new BdService(config);
  await bd.onApplicationBootstrap();
  const outbox = new OutboxRepository(bd);
  const pipeline = new PipelineService(pseudonimo, new MapperService(), firmador, cifrador, outbox);

  ok(
    pseudonimo.partyId.length === PARTY_ID_LARGO && /^hmac:[0-9a-f]{64}$/.test(pseudonimo.partyId),
    `party_id de KMS GenerateMac · ${pseudonimo.partyId.slice(0, 22)}… (${pseudonimo.partyId.length} car)`,
  );

  const doc = JSON.parse(
    readFileSync(join(process.cwd(), 'test', 'vectores', 'documento-valido.json'), 'utf8'),
  ) as Record<string, unknown>;

  // ⚠ SE REFRESCA LA IDENTIDAD, igual que hace el orquestador (regla 11).
  //
  // El vector es un documento FIJO, asi que su payload_hash tambien lo seria.
  // Publicar dos veces el mismo payload_hash hace que SQS FIFO descarte el
  // segundo EN SILENCIO durante 5 minutos, y que el inbox de C4 lo cuente como
  // duplicado despues. Esta prueba pasaria a verde diciendo «duplicados=1» y
  // nadie sabria si el camino sigue funcionando.
  //
  // Los tres campos miden lo mismo que los que sustituyen -UUID 36, ISO 24-,
  // asi que el tamaño canonico no se mueve.
  doc['rpf_id'] = randomUUID();
  doc['event_id'] = randomUUID();
  doc['occurred_at'] = new Date().toISOString();

  const r = await pipeline.procesar([doc]);
  assert.equal(r.descartados.length, 0, `se descarto: ${JSON.stringify(r.descartados)}`);
  const p = r.procesados[0]!;
  ok(true, `C3 firmo y cifro · ${p.bytesCanonicos} B canonicos → ${p.bytesSobre} B de sobre`);

  // ── 2 · Y ahora C4. Exactamente lo que hace su procesador ────────────────
  const kms = new KMSClient({ region: REGION });

  // 2a · la guarda barata, ANTES de gastar un Decrypt
  const sobre = parsearSobre(JSON.stringify(p.sobre));
  ok(sobre.v === 1 && sobre.alg === 'AES-256-GCM' && sobre.sig_alg === 'Ed25519', 'parsearSobre lo acepta');

  // 2b · Decrypt de la edk. Es lo que C3 NO puede hacer, y C4 sí.
  const dec = await kms.send(
    new DecryptCommand({
      CiphertextBlob: Buffer.from(sobre.edk, 'base64'),
      KeyId: LLAVES.cifrado,
    }),
  );
  const dataKey = Buffer.from(dec.Plaintext!);
  ok(dataKey.length === 32, `KMS Decrypt devolvio la data key · ${dataKey.length} bytes`);

  // 2c · abrir el sobre. Revienta si el tag de GCM no cuadra.
  const contenido = abrir(sobre, dataKey);
  ok(typeof contenido.signature === 'string', 'el sobre ABRE · AES-256-GCM');

  // 2d · lista blanca. Sin esto la firma prueba integridad, no autoria.
  ok(sobre.key_id === LLAVES.firma, `el key_id es el de la llave de firma esperada`);

  // 2e · verificacion LOCAL con GetPublicKey, como C4 (nunca kms:Verify)
  const pub = await kms.send(new GetPublicKeyCommand({ KeyId: sobre.key_id }));
  const publica = createPublicKey({
    key: Buffer.from(pub.PublicKey!),
    format: 'der',
    type: 'spki',
  });
  const canonico = Buffer.from(canonicalize(contenido.payload), 'utf8');
  ok(
    verify(null, canonico, publica, Buffer.from(contenido.signature, 'base64')),
    'la firma de KMS VERIFICA con Ed25519 puro',
  );

  // ── 3 · las comprobaciones de coherencia que hace C4 ─────────────────────
  ok(payloadHash(contenido.payload) === p.payloadHash, 'el payload_hash declarado es el que C4 recalcula');
  ok(contenido.payload['party_id'] === pseudonimo.partyId, 'el party_id que llego es el HMAC real, no el placeholder');
  ok(
    Buffer.byteLength(canonicalize(contenido.payload), 'utf8') === p.bytesCanonicos,
    'el documento descifrado pesa lo mismo que el que se firmo',
  );

  // ── 4 · y que un byte cambiado lo tumbe ──────────────────────────────────
  const tocado = { ...contenido.payload, sequence: (contenido.payload['sequence'] as number) + 1 };
  ok(
    !verify(null, Buffer.from(canonicalize(tocado), 'utf8'), publica, Buffer.from(contenido.signature, 'base64')),
    'un byte cambiado invalida la firma',
  );

  // ── 5 · EL CAMINO COMPLETO · publicar en la cola FIFO real ───────────────
  //
  // Esto es lo que hara C-06. Los dos atributos van EN CLARO: el cuerpo esta
  // cifrado, asi que SQS no puede leer nada de el — el rpf_id y el
  // payload_hash tienen que viajar fuera o el ordenamiento por expediente y la
  // deduplicacion no tendrian de donde salir.
  const sqs = new SQSClient({ region: REGION });
  const env = await sqs.send(
    new SendMessageCommand({
      QueueUrl: COLA,
      MessageBody: JSON.stringify(p.sobre),
      MessageGroupId: p.rpfId,
      MessageDeduplicationId: p.payloadHash,
    }),
  );
  ok(!!env.MessageId, `publicado en la cola FIFO real · msg ${env.MessageId?.slice(0, 8)}...`);
  console.log(`\n  rpf_id       ${p.rpfId}`);
  console.log(`  payload_hash ${p.payloadHash}`);
  console.log(`  party_id     ${pseudonimo.partyId}`);
  console.log('\n  Le toca al worker de C4.');
  sqs.destroy();

  firmador.onApplicationShutdown();
  cifrador.onApplicationShutdown();
  pseudonimo.onApplicationShutdown();
  await bd.onApplicationShutdown();
  kms.destroy();

  console.log(
    process.exitCode
      ? '\n✘ hay fallos\n'
      : '\n✔ C3 firmo, cifro y publico — con KMS y cola reales\n',
  );
}

main().catch((e) => {
  console.error('\n✘', e);
  process.exit(1);
});
