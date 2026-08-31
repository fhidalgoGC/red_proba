/**
 * C-06 · lo que C3 pone en el mensaje SQS.
 *
 * Tres atributos, y los tres son contrato con C4 — que esta en otra cuenta,
 * en otra VPC y sin una sola ruta de red hacia aqui (D-03). Si uno cambia de
 * este lado, el sintoma al otro no es un error de compilacion: es un numero
 * que sale mal.
 *
 *   MessageGroupId          = rpf_id        el orden del expediente
 *   MessageDeduplicationId  = payload_hash  la idempotencia (regla 5)
 *   MessageAttributes.prueba = x-prueba-id  el id de corrida, para que las
 *                                           metricas de C4 se puedan separar
 *                                           por prueba igual que las de C3
 *
 * Lo que este test defiende del tercero: que viaja FUERA del payload (el
 * payload va firmado, regla 8), que no se inventa cuando no lo hay, y que no
 * toca el `MessageDeduplicationId` — si la deduplicacion fuera por contenido,
 * anadir un atributo la habria roto en silencio.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PublicadorService } from '../src/relay/publicador.service';
import type { ConfigService } from '../src/config/config.service';
import type { Reclamado } from '../src/bd/outbox.repository';

const config = {
  region: 'us-west-2',
  colaUrl: 'https://sqs.us-west-2.amazonaws.com/1/cola.fifo',
} as unknown as ConfigService;

function fila(sobre: Partial<Reclamado> = {}): Reclamado {
  return {
    id: '1',
    rpfId: '11111111-1111-4111-8111-111111111111',
    payloadHash: 'a'.repeat(64),
    envelope: { v: 1, ct: 'x' },
    prueba: 'corrida-1',
    e4Commit: new Date().toISOString(),
    e5Reclamado: new Date().toISOString(),
    ...sobre,
  } as Reclamado;
}

/** Publica y devuelve las `Entries` que se le pasaron a SQS. */
async function entradasDe(filas: Reclamado[]): Promise<Array<Record<string, unknown>>> {
  const pub = new PublicadorService(config);
  let capturadas: Array<Record<string, unknown>> = [];
  // Se sustituye el cliente entero: lo que interesa es QUE se le manda, no
  // que SQS lo acepte. Con la cola de verdad este test necesitaria una cuenta.
  (pub as unknown as { sqs: unknown }).sqs = {
    send: (c: unknown) => {
      capturadas = (c as { input: { Entries: Array<Record<string, unknown>> } }).input.Entries;
      return Promise.resolve({ Successful: capturadas.map((e) => ({ Id: e.Id })), Failed: [] });
    },
    destroy: () => undefined,
  };
  await pub.publicar(filas);
  await pub.onApplicationShutdown();
  return capturadas;
}

test('el id de corrida viaja como MessageAttribute, fuera del cuerpo', async () => {
  const e = (await entradasDe([fila({ prueba: 'corrida-1' })]))[0]!;

  assert.equal(
    (e.MessageAttributes as { prueba: { StringValue: string } }).prueba.StringValue,
    'corrida-1',
  );
  // Y NO dentro del sobre. El payload va firmado: meterle el id de la corrida
  // cambiaria lo que se firma (regla 8) y ademas dejaria metadato de la prueba
  // dentro del asiento fiscal que guarda el operador neutro.
  assert.ok(!(e.MessageBody as string).includes('corrida-1'));
});

test('sin id de corrida no se inventa un atributo', async () => {
  // Una corrida lanzada sin cabecera `x-prueba-id`. C4 la contabiliza bajo
  // `sin-id`; mandar la cadena vacia haria que SQS rechazara el mensaje entero
  // por un atributo sin valor.
  const e = (await entradasDe([fila({ prueba: null })]))[0]!;
  assert.equal(e.MessageAttributes, undefined);
});

test('el atributo no toca el orden ni la deduplicacion', async () => {
  const e = (await entradasDe([fila()]))[0]!;
  assert.equal(e.MessageGroupId, '11111111-1111-4111-8111-111111111111');
  assert.equal(e.MessageDeduplicationId, 'a'.repeat(64));
});

test('cada fila lleva su propia corrida: un lote puede mezclar dos', async () => {
  // El relay reclama del outbox sin filtrar por prueba, asi que un lote puede
  // traer filas de dos corridas solapadas. Poner la de la primera fila en todo
  // el lote haria que C4 apuntara el trafico de una prueba al archivo de otra.
  const entradas = await entradasDe([fila({ prueba: 'a' }), fila({ id: '2', prueba: 'b' })]);
  const valor = (e: Record<string, unknown>) =>
    (e.MessageAttributes as { prueba: { StringValue: string } }).prueba.StringValue;
  assert.deepEqual(entradas.map(valor), ['a', 'b']);
});
