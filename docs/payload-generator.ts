/**
 * API-01 — Generador de payloads sintéticos.
 *
 * El API recibe { n } y este módulo produce n eventos con la forma del
 * documento fiscal real. ⚠ ESTE ARCHIVO ES LA VERSIÓN HISTÓRICA (~52 atributos,
 * ~1.4 KB). El generador vigente vive en orquestador/src/generador/payload.ts:
 * 70 atributos hoja y tamaño sorteado en [2048, 4096].
 *
 * Reglas que NO se pueden romper (ver D-08):
 *  - Todo importe monetario es STRING, nunca number. Un float pierde
 *    precisión (0.1 + 0.2 !== 0.3) y la firma dejaría de verificar contra
 *    el mismo dato leído de otro lado.
 *  - La chave de acesso son 44 dígitos: como number se convierte en un
 *    double y pierde los últimos dígitos. String siempre.
 *  - Nada de Date.now() ni Math.random() dentro del objeto firmado sin
 *    que quede registrado: el payload tiene que ser reproducible a partir
 *    de la semilla para poder depurar una firma que no verifica.
 *  - Todo evento pesa EXACTAMENTE 3072 bytes canónicos. El contenido es
 *    aleatorio y de largo variable; el campo `padding` absorbe la diferencia.
 *    Se mide sobre la forma canónica en BYTES (Buffer.byteLength), no sobre
 *    string.length: si algún campo trae acentos, un carácter son 2 bytes.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';

/** Tamaño exacto de cada evento, en bytes de la forma canónica. */
export const TARGET_BYTES = 3072;

/**
 * Alfabeto base64. Se usa para el relleno por dos razones:
 *  - Es ASCII puro: 1 carácter = 1 byte, así que el ajuste es exacto.
 *  - Ningún carácter necesita escape en JSON, así que serializar no
 *    cambia el largo. Con bytes crudos, una comilla o una barra se
 *    escaparían y el payload saldría más grande de lo calculado.
 */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export interface GenOptions {
  tenantId: string;
  /** Semilla: misma semilla -> mismos payloads. Indispensable para depurar. */
  seed?: number;
  /** Ítems por documento. Cada ítem suma ~165 bytes. */
  itemsPerDoc?: number;
  /** Eventos por rpf_id. Controla el reparto de MessageGroupId en la cola. */
  eventsPerThread?: number;
}

/** PRNG determinista (mulberry32). No usar Math.random: no es reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const UF = ['SP', 'PR', 'MG', 'RS', 'BA', 'SC', 'GO', 'PE'];
const PRODUCTOS = [
  { code: 'MP-4471-A', desc: 'Chapa aco carbono 2.00mm', ncm: '72083990', unit: 'KG' },
  { code: 'MP-8823-C', desc: 'Perfil U dobrado 100x50mm', ncm: '72166100', unit: 'PC' },
  { code: 'MP-1195-B', desc: 'Bobina aco zincado 1.20mm', ncm: '72104900', unit: 'KG' },
  { code: 'MP-6602-D', desc: 'Tubo redondo 50.8x2.25mm', ncm: '73063000', unit: 'MT' },
];

/** Importes en centavos -> string con 2 decimales. Nunca aritmética en float. */
const brl = (centavos: number): string =>
  `${Math.trunc(centavos / 100)}.${String(Math.abs(centavos) % 100).padStart(2, '0')}`;

/** Pseudónimo de tenant vía HMAC. En producción la llave vive en KMS (D-04). */
const partyId = (tenantId: string, key: string): string =>
  'hmac:' + createHash('sha256').update(key + tenantId).digest('hex').slice(0, 32);

const digitos = (r: () => number, n: number): string =>
  Array.from({ length: n }, () => Math.floor(r() * 10)).join('');

export function* generarPayloads(n: number, opts: GenOptions): Generator<object> {
  const {
    tenantId,
    seed = 1,
    itemsPerDoc = 2,
    eventsPerThread = 1,
  } = opts;

  const r = rng(seed);
  const ref = partyId(tenantId, process.env.TENANT_PSEUDO_KEY ?? 'poc');

  let rpfId = randomUUID();
  let seq = 0;

  for (let i = 0; i < n; i++) {
    // Un rpf_id nuevo cada eventsPerThread: así controlas cuántos grupos
    // distintos ve la cola. Con eventsPerThread=1 tienes paralelismo máximo;
    // con 50 fuerzas orden estricto dentro de cada expediente.
    if (i % eventsPerThread === 0) {
      rpfId = randomUUID();
      seq = 0;
    }
    seq++;

    // --- ítems y aritmética en centavos ---
    const items = [];
    let productosCent = 0;

    for (let l = 1; l <= itemsPerDoc; l++) {
      const p = PRODUCTOS[Math.floor(r() * PRODUCTOS.length)];
      const qtyMil = Math.floor(r() * 2_000_000) + 1000;      // milésimas
      const priceCentMil = Math.floor(r() * 800_000) + 10_000; // 1/10000
      const totalCent = Math.round((qtyMil * priceCentMil) / 1_000_000);
      productosCent += totalCent;

      items.push({
        line: l,
        code: p.code,
        description: p.desc,
        ncm: p.ncm,
        unit: p.unit,
        quantity: `${Math.trunc(qtyMil / 1000)}.${String(qtyMil % 1000).padStart(3, '0')}`,
        unit_price: `${Math.trunc(priceCentMil / 10000)}.${String(priceCentMil % 10000).padStart(4, '0')}`,
        total: brl(totalCent),
      });
    }

    const descuentoCent = Math.floor(productosCent * 0.02);
    const freteCent = Math.floor(r() * 150_000);
    const baseCent = productosCent - descuentoCent + freteCent;
    const icmsCent = Math.round(baseCent * 0.12);
    const ipiCent = Math.round(productosCent * 0.05);
    const pisCent = Math.round(baseCent * 0.0165);
    const cofinsCent = Math.round(baseCent * 0.076);

    const ufOrigem = 'SP';
    const ufDestino = UF[Math.floor(r() * UF.length)];

    yield {
      rpf_id: rpfId,
      event_id: randomUUID(),
      event_type: 'fiscal.document.issued',
      schema_version: '1.4.0',
      occurred_at: new Date().toISOString(),
      sequence: seq,
      party_id: ref,

      participant: {
        cnpj: digitos(r, 14),
        ie: digitos(r, 12),
        legal_name: 'Metalurgica Paulista Ltda',
        municipality_code: '3550308',
        uf: ufOrigem,
      },

      counterparty: {
        cnpj: digitos(r, 14),
        ie: digitos(r, 9),
        legal_name: 'Distribuidora Sul SA',
        uf: ufDestino,
      },

      document: {
        model: '55',
        series: '003',
        number: String(1_000_000 + i).slice(-9).padStart(9, '0'),
        access_key: digitos(r, 44),          // 44 dígitos: SIEMPRE string
        issued_at: new Date().toISOString(),
        operation: 'saida',
        cfop: ufOrigem === ufDestino ? '5102' : '6102',
        nature: 'Venda de mercadoria de terceiros',
      },

      totals: {
        items_count: items.length,
        products: brl(productosCent),
        discount: brl(descuentoCent),
        freight: brl(freteCent),
        tax_base: brl(baseCent),
        icms: brl(icmsCent),
        ipi: brl(ipiCent),
        pis: brl(pisCent),
        cofins: brl(cofinsCent),
        total: brl(baseCent),
      },

      items,

      transport: {
        mode: 'cif',
        carrier_cnpj: digitos(r, 14),
        vehicle_plate: 'BRA2E19',
        gross_weight: brl(Math.floor(r() * 500_000)),
      },

      payment: {
        method: 'boleto',
        installments: 1 + Math.floor(r() * 6),
        due_first: '2026-09-28',
      },

      origin: {
        system: 'erp-connector',
        version: '3.11.2',
        environment: 'poc',
      },
    };
  }
}

/**
 * Ajusta el evento a exactamente TARGET_BYTES añadiendo `padding`.
 *
 * Se hace en dos pasos porque el propio campo ocupa espacio: primero se
 * canoniza con padding vacío para conocer el costo del envoltorio
 * (`,"padding":""` son 14 bytes), y el resto se rellena carácter a carácter.
 *
 * `canonicalize` debe ser la MISMA implementación de JCS que usa el Signer.
 * Si mides con una y firmas con otra, el tamaño no cuadra.
 */
export function ajustarATamano<T extends object>(
  evento: T,
  canonicalize: (o: unknown) => string,
  target = TARGET_BYTES,
): T & { padding: string } {
  if ('padding' in evento) {
    throw new Error('el evento ya trae padding');
  }

  const conVacio = Buffer.byteLength(
    canonicalize({ ...evento, padding: '' }), 'utf8',
  );
  const faltan = target - conVacio;

  if (faltan < 0) {
    // Pasa si subes itemsPerDoc demasiado. Falla ruidoso: un evento
    // que no cumple el tamaño invalida la comparación de la prueba.
    throw new Error(
      `el evento pesa ${conVacio} bytes sin relleno y el objetivo es ${target}. ` +
      `Baja itemsPerDoc o sube el objetivo.`,
    );
  }

  const buf = randomBytes(faltan);
  let padding = '';
  for (let i = 0; i < faltan; i++) padding += B64[buf[i] & 63];

  const salida = { ...evento, padding };

  // Verificación barata: si esto se dispara, el canonicalizador no es el
  // mismo que asumiste. Vale mucho más detectarlo aquí que en la firma.
  const real = Buffer.byteLength(canonicalize(salida), 'utf8');
  if (real !== target) {
    throw new Error(`quedó en ${real} bytes, se esperaban ${target}`);
  }

  return salida;
}

/** Uso: cada evento sale ya ajustado a 3072 bytes. */
export function* generarPayloadsAjustados(
  n: number,
  opts: GenOptions,
  canonicalize: (o: unknown) => string,
): Generator<object> {
  for (const evento of generarPayloads(n, opts)) {
    yield ajustarATamano(evento, canonicalize);
  }
}
