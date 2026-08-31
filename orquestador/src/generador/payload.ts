/**
 * Generador de documentos fiscales sinteticos.
 *
 * Portado de docs/payload-generator.ts. Cambio de dominio: esto ya NO vive en
 * C3. El orquestador construye los documentos y se los manda hechos a cada
 * tenant; C3 solo canoniza, firma, cifra y persiste. Eso alinea el codigo con
 * lo que docs/07-medicion.md ya decia — que el generador queda FUERA del
 * alcance de la medicion.
 *
 * Reglas que no se negocian (ver CLAUDE.md):
 *  - Todo importe es STRING. JCS serializa numeros como doubles de ECMAScript;
 *    un importe en punto flotante (0.30000000000000004) rompe la firma. Toda
 *    la aritmetica va en centavos ENTEROS y solo se formatea al final.
 *  - La access_key de 44 digitos, por lo mismo: como numero pierde los
 *    ultimos digitos.
 *  - Nada de Math.random() en lo que se firma. PRNG con semilla, para que un
 *    evento cuya firma no verifique se pueda regenerar exactamente.
 *  - Se mide en BYTES (Buffer.byteLength), nunca en caracteres.
 */

import { randomBytes } from 'node:crypto';
import { bytesCanonicos } from './jcs';

/**
 * Techo del tamaño canonico. Es el valor de docs/02-payload.md y sigue siendo
 * el maximo del rango, pero YA NO es el tamaño de todos los eventos: las
 * plantillas se generan con tamaños variados dentro de un rango configurable.
 *
 * Por que variado: un flujo real de documentos fiscales no tiene todos el
 * mismo peso, y un tamaño unico esconde dos cosas — como se comporta la firma
 * y el cifrado con entradas de largo distinto, y cuanto del throughput es
 * eventos/s contra cuanto es MB/s. Con tamaño fijo esas dos metricas son la
 * misma; con tamaño variado se separan, y esa separacion es la que dice si el
 * cuello de botella es por operacion o por byte.
 */
export const BYTES_MAXIMO = 3072;

/**
 * Piso duro, MEDIDO, no estimado.
 *
 * El esqueleto del documento fiscal — los ~52 atributos hoja de
 * docs/02-payload.md, sin un solo item — pesa 1.270 bytes canonicos. Con el
 * item minimo (uno; un documento fiscal sin items no existe) son 1.433.
 *
 * Subio 30 bytes cuando `party_id` paso a llevar el HMAC-SHA256 completo:
 * el valor crece 32 caracteres y el nombre del campo se acorta 2.
 * MEDIDO con `construirPlantilla`, no calculado a mano.
 *
 * Es decir: pedir plantillas de 1 KB es imposible sin mutilar el documento, y
 * mutilarlo invalidaria la comparacion. El rango util empieza aqui.
 */
export const BYTES_MINIMO_VIABLE = 1433;

/**
 * Relleno que se reserva SIEMPRE, aunque el evento ya llegue al target.
 *
 * El pool sustituye `sequence` al enviar y compensa la diferencia de digitos
 * recortando el relleno. Si un evento saliera con relleno 0, un `sequence` de
 * 2 digitos no tendria de donde recortar y el tamaño se rompería en silencio.
 * 8 bytes cubren hasta `sequence` de 9 digitos.
 */
export const RESERVA_RELLENO = 8;

/** Estimacion conservadora del costo de un item, para elegir cuantos entran. */
const BYTES_POR_ITEM = 170;
const BYTES_SIN_ITEMS = 1270;

/**
 * Alfabeto base64 para el relleno. Dos razones, ambas de aritmetica:
 *  - Es ASCII puro: 1 caracter = 1 byte, el ajuste sale exacto.
 *  - Ningun caracter necesita escape en JSON, asi que serializar no cambia
 *    el largo. Con bytes crudos, una comilla o una barra se escaparian.
 */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Placeholder de `party_id`, de LARGO FIJO: 'hmac:' + 64 hex = 69 caracteres.
 *
 * 64 hex y no 32: es un HMAC-SHA256 COMPLETO, sin truncar. El paso ② del
 * pipeline RPF (Hashing) produce `payload_hash` con SHA-256 y `party_id` con
 * HMAC-SHA256, y truncar el segundo a la mitad lo apartaria del protocolo sin
 * ganar nada — los 32 bytes caben de sobra en el presupuesto de tamaño.
 *
 * La plantilla no puede traer el party_id real, porque entonces cada plantilla
 * seria de un solo tenant y necesitariamos 1.000 plantillas POR tenant. Se
 * sustituye al enviar, y como el reemplazo tiene exactamente el mismo largo,
 * el tamaño canonico no se mueve.
 *
 * Quien escribe el valor real es C3, con `KMS_HMAC_KEY_ID`. La llave de
 * pseudonimizacion nunca sale del dominio del participante.
 */
export const PARTY_ID_PLACEHOLDER = 'hmac:' + '0'.repeat(64);
export const PARTY_ID_LARGO = PARTY_ID_PLACEHOLDER.length;

/** PRNG determinista (mulberry32). No usar Math.random: no es reproducible. */
export function prng(semilla: number): () => number {
  let a = semilla >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const UF = ['SP', 'PR', 'MG', 'RS', 'BA', 'SC', 'GO', 'PE'] as const;

const PRODUCTOS = [
  { code: 'MP-4471-A', desc: 'Chapa aco carbono 2.00mm', ncm: '72083990', unit: 'KG' },
  { code: 'MP-8823-C', desc: 'Perfil U dobrado 100x50mm', ncm: '72166100', unit: 'PC' },
  { code: 'MP-1195-B', desc: 'Bobina aco zincado 1.20mm', ncm: '72104900', unit: 'KG' },
  { code: 'MP-6602-D', desc: 'Tubo redondo 50.8x2.25mm', ncm: '73063000', unit: 'MT' },
] as const;

/** Centavos enteros -> string con 2 decimales. Nunca aritmetica en float. */
const brl = (centavos: number): string =>
  `${Math.trunc(centavos / 100)}.${String(Math.abs(centavos) % 100).padStart(2, '0')}`;

const digitos = (r: () => number, n: number): string => {
  let s = '';
  for (let i = 0; i < n; i++) s += Math.floor(r() * 10);
  return s;
};

/**
 * Un documento fiscal. Se tipa flojo a proposito: la forma exacta la define
 * docs/02-payload.md y el consumidor real es C3, que lo trata como opaco.
 */
export interface Documento {
  rpf_id: string;
  event_id: string;
  event_type: string;
  schema_version: string;
  occurred_at: string;
  sequence: number;
  party_id: string;
  padding: string;
  [k: string]: unknown;
}

export interface OpcionesPlantilla {
  /** Rango [min, max] inclusivo del tamaño canonico objetivo, en bytes. */
  tamanoBytes: [number, number];
  /** Rango [min, max] inclusivo de items. Se recorta si no entra en el target. */
  itemsPorDocumento: [number, number];
}

/** Una plantilla y el tamaño canonico exacto al que quedo ajustada. */
export interface Plantilla {
  doc: Documento;
  bytes: number;
}

/**
 * Construye UNA plantilla: todo el contenido caro (items, importes, CNPJs,
 * relleno) ya resuelto y ya ajustado a 3.072 bytes exactos.
 *
 * Los campos de identidad (rpf_id, event_id, sequence, occurred_at,
 * party_id) llevan valores canarios de LARGO CORRECTO. El pool los
 * sustituye al enviar; ver pool.service.ts.
 */
export function construirPlantilla(
  indice: number,
  r: () => number,
  opts: OpcionesPlantilla,
): Plantilla {
  const [minB, maxB] = opts.tamanoBytes;
  const target = minB + Math.floor(r() * (maxB - minB + 1));

  const [minI, maxI] = opts.itemsPorDocumento;
  const sorteados = minI + Math.floor(r() * (maxI - minI + 1));

  // Cuantos items caben de verdad en este target. Sin este recorte, una
  // plantilla chica sorteada con 5 items reventaria el ajuste y el pool no
  // arrancaria — y el mensaje de error apuntaria al lugar equivocado.
  const caben = Math.floor((target - RESERVA_RELLENO - BYTES_SIN_ITEMS) / BYTES_POR_ITEM);
  const nItems = Math.max(1, Math.min(sorteados, caben));

  const items: Array<Record<string, unknown>> = [];
  let productosCent = 0;

  for (let l = 1; l <= nItems; l++) {
    const p = PRODUCTOS[Math.floor(r() * PRODUCTOS.length)]!;
    const qtyMil = Math.floor(r() * 2_000_000) + 1000;        // milesimas
    const priceCentMil = Math.floor(r() * 800_000) + 10_000;  // 1/10000
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
  const ufDestino = UF[Math.floor(r() * UF.length)]!;

  // Fecha canaria de largo fijo (24 caracteres, como todo toISOString()).
  // No se usa new Date() aqui: la plantilla tiene que ser reproducible a
  // partir de la semilla, y la fecha real se pone al enviar.
  const fechaCanaria = '2026-01-01T00:00:00.000Z';

  const sinRelleno = {
    // --- identidad: valores canarios, largo correcto, se sustituyen al enviar
    rpf_id: '00000000-0000-4000-8000-000000000000',
    event_id: '00000000-0000-4000-8000-000000000000',
    event_type: 'fiscal.document.issued',
    schema_version: '1.4.0',
    occurred_at: fechaCanaria,
    sequence: 1,
    party_id: PARTY_ID_PLACEHOLDER,

    // --- contenido: esto es lo caro, y es lo que se reusa
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
      number: String(1_000_000 + indice).slice(-9).padStart(9, '0'),
      access_key: digitos(r, 44),          // 44 digitos: SIEMPRE string
      issued_at: fechaCanaria,
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

  return { doc: ajustarATamano(sinRelleno, target), bytes: target };
}

/**
 * Ajusta el evento a exactamente BYTES_OBJETIVO añadiendo `padding`.
 *
 * Dos pasos, porque el propio campo ocupa espacio: primero se canoniza con
 * padding vacio para conocer el costo del envoltorio (`,"padding":""` son 14
 * bytes), y el resto se rellena caracter a caracter.
 */
export function ajustarATamano<T extends object>(
  evento: T,
  target = BYTES_MAXIMO,
): T & { padding: string } {
  if ('padding' in evento) {
    throw new Error('el evento ya trae padding');
  }

  const conVacio = bytesCanonicos({ ...evento, padding: '' });
  const faltan = target - conVacio;

  if (faltan < RESERVA_RELLENO) {
    // Falla ruidoso: un evento que no cumple el tamaño invalida la
    // comparacion de la prueba, y uno sin relleno de reserva se rompe mas
    // tarde, al sustituir `sequence`, que es mucho peor de diagnosticar.
    throw new Error(
      `el evento pesa ${conVacio} bytes sin relleno y el objetivo es ${target} ` +
      `(hacen falta ${RESERVA_RELLENO} de reserva). Baja items_por_documento ` +
      `o sube pool.tamano_bytes.`,
    );
  }

  const salida = { ...evento, padding: relleno(faltan) };

  // Verificacion barata. Si esto se dispara, el canonicalizador no es el que
  // asumiste — y detectarlo aqui cuesta mucho menos que detectarlo en la firma.
  const real = bytesCanonicos(salida);
  if (real !== target) {
    throw new Error(`quedo en ${real} bytes, se esperaban ${target}`);
  }

  return salida;
}

/**
 * n caracteres del alfabeto base64. El relleno SI puede ser aleatorio de
 * verdad: no se firma su contenido, solo importa su largo.
 */
export function relleno(n: number): string {
  if (n <= 0) return '';
  const buf = randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += B64[buf[i]! & 63];
  return s;
}
