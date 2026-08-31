/**
 * Herramienta manual para vaciar la DLQ.
 *
 * Vive APARTE del consumidor a proposito. C4 mira la profundidad de la DLQ
 * pero nunca la consume: leerla y borrarla destruiria la evidencia para la
 * que existe. Drenarla tiene que ser un acto deliberado de alguien, no un
 * efecto secundario de que el worker siga corriendo.
 *
 *   node dist-test/test/drenar-dlq.js            solo lista
 *   node dist-test/test/drenar-dlq.js --borrar   lista y vacia
 */
import {
  DeleteMessageBatchCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { DLQ, REGION } from './entorno';

const BORRAR = process.argv.includes('--borrar');

async function main(): Promise<void> {
  const sqs = new SQSClient({ region: REGION });
  const porMotivo = new Map<string, number>();
  let total = 0;

  console.log(`${BORRAR ? 'drenando' : 'inspeccionando'} ${DLQ}\n`);

  for (;;) {
    const r = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: DLQ,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 2,
        MessageAttributeNames: ['All'],
        MessageSystemAttributeNames: ['All'],
      }),
    );
    const ms = r.Messages ?? [];
    if (ms.length === 0) break;

    for (const m of ms) {
      const motivo = m.MessageAttributes?.motivo?.StringValue ?? 'sin-motivo';
      porMotivo.set(motivo, (porMotivo.get(motivo) ?? 0) + 1);
      total += 1;
    }

    if (!BORRAR) {
      // Sin --borrar los mensajes vuelven al vencer el visibility timeout.
      // Se corta tras la primera vuelta o el lazo no terminaria nunca.
      break;
    }
    await sqs.send(
      new DeleteMessageBatchCommand({
        QueueUrl: DLQ,
        Entries: ms.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle as string })),
      }),
    );
  }

  console.log(`${total} mensajes${BORRAR ? ' borrados' : ' (primera pagina)'}:`);
  for (const [motivo, n] of [...porMotivo].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)} · ${motivo}`);
  }
  sqs.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
