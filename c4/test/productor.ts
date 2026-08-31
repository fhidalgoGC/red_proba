/**
 * Productor de prueba — hace de C3 SIN TOCAR C3.
 *
 * Firma con la llave Ed25519 real de KMS, cifra con AES-256-GCM bajo una data
 * key real de la llave simetrica de C4, y publica en la cola FIFO real. Es
 * decir: produce exactamente los bytes que C4 va a encontrarse en produccion.
 *
 * ⚠ Esto NO es C3 ni pretende serlo. No hay outbox, no hay relay, no hay
 * transaccion de negocio, no hay marcas e0..e6. Es el minimo que hace falta
 * para que C4 tenga algo legitimo que abrir — y, sobre todo, algo
 * ilegitimo con lo que probar los caminos de G-07.
 */
import { GenerateDataKeyCommand, KMSClient, SignCommand } from '@aws-sdk/client-kms';
import { SendMessageBatchCommand, SQSClient } from '@aws-sdk/client-sqs';
import { randomUUID } from 'node:crypto';
import { canonicalize } from '../src/comun/jcs';
import { payloadHash, sellar, type Sobre } from '../src/comun/sobre';

export interface OpcionesProductor {
  region: string;
  colaUrl: string;
  llaveFirma: string;
  llaveCifrado: string;
}

export interface Publicado {
  payloadHash: string;
  rpfId: string;
  sequence: number;
  eventId: string;
  bytesCanonicos: number;
  bytesSobre: number;
  payload: Record<string, unknown>;
  sobre: Sobre;
}

/** PRNG con semilla. Nada de Math.random() en lo que se firma (regla 9). */
export function prng(semilla: number): () => number {
  let s = semilla >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 16), 0x21f0aaad);
    t = Math.imul(t ^ (t >>> 15), 0x735a2d97);
    return ((t ^ (t >>> 15)) >>> 0) / 4294967296;
  };
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const UF = ['SP', 'PR', 'MG', 'RS', 'BA', 'SC'] as const;

/** Importes en centavos enteros, formateados al final (regla 1 / PL-03). */
const brl = (centavos: number): string => (centavos / 100).toFixed(2);

const digitos = (r: () => number, n: number): string => {
  let s = '';
  for (let i = 0; i < n; i++) s += Math.floor(r() * 10);
  return s;
};

/**
 * Documento fiscal sintetico. No es el generador del orquestador -ese vive
 * alla y ahi se queda-: es lo minimo con la forma correcta, del tamano
 * correcto, para que lo que C4 abra se parezca a lo real.
 */
export function documento(
  r: () => number,
  rpfId: string,
  sequence: number,
  tamanoObjetivo: number,
  partyId: string,
): Record<string, unknown> {
  const items = 1 + Math.floor(r() * 3);
  let productos = 0;
  const lineas = Array.from({ length: items }, (_, i) => {
    const cantidad = 1 + Math.floor(r() * 20);
    const unitario = 1000 + Math.floor(r() * 50000);
    productos += cantidad * unitario;
    return {
      line: i + 1,
      code: `SKU-${digitos(r, 6)}`,
      description: `PRODUTO GENERICO ${i + 1}`,
      ncm: digitos(r, 8),
      unit: 'UN',
      quantity: String(cantidad),
      unit_price: brl(unitario),
      total: brl(cantidad * unitario),
    };
  });

  const icms = Math.round(productos * 0.18);
  const base = {
    rpf_id: rpfId,
    event_id: randomUUID(),
    event_type: 'fiscal.document.issued',
    schema_version: '1.0.0',
    occurred_at: new Date().toISOString(),
    sequence,
    party_id: partyId,
    participant: {
      cnpj: digitos(r, 14),
      ie: digitos(r, 9),
      legal_name: 'INDUSTRIA BRASILEIRA LTDA',
      municipality_code: digitos(r, 7),
      uf: UF[Math.floor(r() * UF.length)] as string,
    },
    counterparty: {
      cnpj: digitos(r, 14),
      ie: digitos(r, 9),
      legal_name: 'COMERCIO ATACADISTA SA',
      uf: UF[Math.floor(r() * UF.length)] as string,
    },
    document: {
      model: '55',
      series: '001',
      number: digitos(r, 9),
      // 44 digitos como STRING: como numero perderia los ultimos (regla 1).
      access_key: digitos(r, 44),
      cfop: '5102',
      nature: 'VENDA DE MERCADORIA',
      issued_at: new Date().toISOString(),
    },
    totals: {
      products: brl(productos),
      discount: '0.00',
      freight: brl(Math.floor(r() * 20000)),
      tax_base: brl(productos),
      icms: brl(icms),
      ipi: brl(Math.round(productos * 0.05)),
      total: brl(productos + icms),
    },
    items: lineas,
    transport: { mode: '1', carrier_cnpj: digitos(r, 14), vehicle_plate: 'ABC1D23', gross_weight: '120.500' },
    payment: { method: '01', installments: 1, due_first: new Date().toISOString().slice(0, 10) },
    origin: { system: 'productor-de-prueba', version: '0.1.0', environment: 'poc' },
  };

  return ajustarATamano(base, tamanoObjetivo);
}

/** Mismo algoritmo que 02-payload: el relleno absorbe la diferencia exacta. */
export function ajustarATamano<T extends object>(
  evento: T,
  objetivo: number,
): T & { padding: string } {
  const conVacio = Buffer.byteLength(canonicalize({ ...evento, padding: '' }), 'utf8');
  const faltan = objetivo - conVacio;
  if (faltan < 0) throw new Error(`pesa ${conVacio} sin relleno, objetivo ${objetivo}`);

  // El relleno no se firma por su contenido, solo por su largo: aqui si puede
  // ser aleatorio sin semilla (PL-05).
  let padding = '';
  for (let i = 0; i < faltan; i++) padding += B64[Math.floor(Math.random() * 64)];

  const salida = { ...evento, padding };
  const real = Buffer.byteLength(canonicalize(salida), 'utf8');
  if (real !== objetivo) throw new Error(`quedo en ${real}, esperaba ${objetivo}`);
  return salida;
}

export class Productor {
  private readonly kms: KMSClient;
  private readonly sqs: SQSClient;
  private dataKey: { clara: Buffer; cifrada: Buffer } | null = null;

  readonly contadores = { sign: 0, generate_data_key: 0, enviados: 0, fallidos: 0 };

  constructor(private readonly o: OpcionesProductor) {
    this.kms = new KMSClient({ region: o.region });
    this.sqs = new SQSClient({ region: o.region });
  }

  cerrar(): void {
    this.kms.destroy();
    this.sqs.destroy();
  }

  /** Una data key por corrida, como haria C3 con su cache (C-04). */
  async dataKeyVigente(): Promise<{ clara: Buffer; cifrada: Buffer }> {
    if (this.dataKey) return this.dataKey;
    const r = await this.kms.send(
      new GenerateDataKeyCommand({ KeyId: this.o.llaveCifrado, KeySpec: 'AES_256' }),
    );
    this.contadores.generate_data_key += 1;
    this.dataKey = {
      clara: Buffer.from(r.Plaintext as Uint8Array),
      cifrada: Buffer.from(r.CiphertextBlob as Uint8Array),
    };
    return this.dataKey;
  }

  async firmar(canonico: Buffer): Promise<Buffer> {
    const r = await this.kms.send(
      new SignCommand({
        KeyId: this.o.llaveFirma,
        Message: canonico,
        MessageType: 'RAW',
        SigningAlgorithm: 'ED25519_SHA_512',
      }),
    );
    this.contadores.sign += 1;
    return Buffer.from(r.Signature as Uint8Array);
  }

  /** Canonizar → firmar → cifrar. El orden de la regla 6. */
  async preparar(payload: Record<string, unknown>): Promise<Publicado> {
    const canonico = Buffer.from(canonicalize(payload), 'utf8');
    const firma = await this.firmar(canonico);
    const dk = await this.dataKeyVigente();
    const sobre = sellar(
      { payload, signature: firma.toString('base64') },
      dk.clara,
      dk.cifrada,
      this.o.llaveFirma,
    );
    return {
      payloadHash: payloadHash(payload),
      rpfId: String(payload.rpf_id),
      sequence: Number(payload.sequence),
      eventId: String(payload.event_id),
      bytesCanonicos: canonico.length,
      bytesSobre: Buffer.byteLength(JSON.stringify(sobre), 'utf8'),
      payload,
      sobre,
    };
  }

  /**
   * Publica. `sobrescribir` permite mandar un sobre manipulado con los
   * atributos de uno legitimo — que es justo el ataque que G-07 tiene que
   * detectar.
   */
  async publicar(
    items: Array<{ sobre: Sobre; rpfId: string; payloadHash: string }>,
    prueba?: string,
  ): Promise<{ ok: number; fallidos: number }> {
    let ok = 0;
    let fallidos = 0;

    for (let i = 0; i < items.length; i += 10) {
      const lote = items.slice(i, i + 10);
      const r = await this.sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: this.o.colaUrl,
          Entries: lote.map((it, j) => ({
            Id: String(j),
            MessageBody: JSON.stringify(it.sobre),
            MessageGroupId: it.rpfId,
            // Explicito y calculado sobre el CLARO: la dedup por contenido
            // esta desactivada en la cola porque el ciphertext cambia en cada
            // cifrado (regla 5, D-11).
            MessageDeduplicationId: it.payloadHash,
            // El id de corrida, igual que lo pone el relay de C3. Sin el, todo
            // lo que mida C4 en esta corrida cae en `sin-id` y el e2e no
            // ejercitaria el camino que de verdad se usa.
            ...(prueba
              ? { MessageAttributes: { prueba: { DataType: 'String', StringValue: prueba } } }
              : {}),
          })),
        }),
      );
      ok += r.Successful?.length ?? 0;
      fallidos += r.Failed?.length ?? 0;
      if (r.Failed?.length) {
        for (const f of r.Failed) console.error(`  fallo ${f.Id}: ${f.Code} ${f.Message ?? ''}`);
      }
    }

    this.contadores.enviados += ok;
    this.contadores.fallidos += fallidos;
    return { ok, fallidos };
  }
}
