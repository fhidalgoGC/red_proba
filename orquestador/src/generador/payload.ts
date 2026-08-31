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
 * Techo del tamaño canonico. Es el maximo del rango, no el tamaño de todos
 * los eventos: las plantillas se generan con tamaños variados dentro de un
 * rango configurable.
 *
 * ⚠ 4096 NO es un numero elegido por comodidad: es el limite DURO de
 * `kms:Sign` con `MessageType: RAW`, que es lo que exige `ED25519_SHA_512`
 * (ver c3/src/cripto/firmador.service.ts y terraform/modules/security/kms.tf).
 * A 4096 bytes canonicos la firma entra justa, con margen CERO. Subir el techo
 * un solo byte rompe la firma en C3 con un error de KMS, no del generador — y
 * obligaria a pasar a `ED25519_PH_SHA_512` con digest, cambiando C3 y C4 a la
 * vez porque los dos MessageType no son intercambiables.
 *
 * Por que variado: un flujo real de documentos fiscales no tiene todos el
 * mismo peso, y un tamaño unico esconde dos cosas — como se comporta la firma
 * y el cifrado con entradas de largo distinto, y cuanto del throughput es
 * eventos/s contra cuanto es MB/s. Con tamaño fijo esas dos metricas son la
 * misma; con tamaño variado se separan, y esa separacion es la que dice si el
 * cuello de botella es por operacion o por byte.
 */
export const BYTES_MAXIMO = 4096;

/**
 * Piso duro, MEDIDO, no estimado.
 *
 * Es el PEOR caso, no el caso medio: el esqueleto de 70 atributos hoja con un
 * solo item pesa ~2.005 B con valores tipicos y 2.024 B cuando los importes,
 * el numero de puerta y el nombre de calle caen todos en su largo maximo. La
 * validacion tiene que usar el peor caso — si usara el medio, una plantilla
 * desafortunada reventaria `ajustarATamano` a mitad del arranque del pool y el
 * error saldria en la plantilla 700 de 1.000, no en la validacion de config.
 *
 * MEDIDO sobre 1.000.000 de muestras y por el MISMO camino que usa el pool
 * (rango [2048, 4096], items [1, 5]). El camino importa: forzar items [1, 1]
 * consume otros sorteos del PRNG y deja sin explorar la cola de la
 * distribucion — medirlo asi daba 2.041 y el rango real encontraba 2.043.
 *
 * Con la reserva de relleno el piso de `pool.tamano_bytes[0]` es 2.032 B, asi
 * que 2 KB (2.048) entra con 16 bytes de margen.
 *
 * Es decir: pedir plantillas de 1 KB es imposible sin mutilar el documento, y
 * mutilarlo invalidaria la comparacion. El rango util empieza aqui.
 */
export const BYTES_MINIMO_VIABLE = 2024;

/**
 * Relleno que se reserva SIEMPRE, aunque el evento ya llegue al target.
 *
 * El pool sustituye `sequence` al enviar y compensa la diferencia de digitos
 * recortando el relleno. Si un evento saliera con relleno 0, un `sequence` de
 * 2 digitos no tendria de donde recortar y el tamaño se rompería en silencio.
 * 8 bytes cubren hasta `sequence` de 9 digitos.
 */
export const RESERVA_RELLENO = 8;

/**
 * Costo de un item y del esqueleto sin items, los dos en su PEOR caso medido
 * (item: 164 B; esqueleto: 1.864 B con `items: []` y sin relleno). Se usan
 * para decidir cuantos items caben en un target, y sobreestimar es lo correcto:
 * un item de menos deja relleno de sobra, un item de mas rompe el ajuste.
 */
const BYTES_POR_ITEM = 170;
const BYTES_SIN_ITEMS = 1864;

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
 * n caracteres base64 DETERMINISTAS, del PRNG con semilla.
 *
 * No usa `relleno()`: ese tira de randomBytes y vale solo para el padding,
 * cuyo contenido no se firma. Esto sí acaba dentro de lo firmado (el digest de
 * autorizacion), y la regla 9 de CLAUDE.md exige que sea reproducible.
 */
const b64det = (r: () => number, n: number): string => {
  let s = '';
  for (let i = 0; i < n; i++) s += B64[Math.floor(r() * 64)];
  return s;
};

const LOGRADOUROS = ['Rua Ipiranga', 'Av Paulista', 'Rua Bandeirantes', 'Av Faria Lima'] as const;
const BAIRROS = ['Centro', 'Moema', 'Butanta', 'Ipiranga'] as const;
const CIDADES = ['Sao Paulo', 'Campinas', 'Santos', 'Osasco'] as const;

/** Direccion postal: 5 atributos hoja, todos de valor corto. */
const direccion = (r: () => number): Record<string, string> => ({
  street: LOGRADOUROS[Math.floor(r() * LOGRADOUROS.length)]!,
  number: String(100 + Math.floor(r() * 9800)),
  district: BAIRROS[Math.floor(r() * BAIRROS.length)]!,
  city: CIDADES[Math.floor(r() * CIDADES.length)]!,
  zip: digitos(r, 8),
});

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
 * relleno) ya resuelto y ya ajustado al tamaño sorteado para ESTA plantilla,
 * al byte.
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

  // Tributos del bloque `taxes`. Toda la aritmetica en centavos ENTEROS y el
  // formateo al final: un `baseCent * 0.045` en float saldria como
  // 1234.5600000000001 y el importe entraria al documento firmado con basura.
  // El DIFAL es 0 en operacion interna — no se omite el campo, porque un
  // atributo que aparece y desaparece cambia el numero de hojas y con el el
  // tamaño canonico, y el pool asume forma estable.
  const interna = ufOrigem === ufDestino;
  const icmsStCent = Math.round(baseCent * 0.045);
  const fcpCent = Math.round(baseCent * 0.02);
  const difalOrigCent = interna ? 0 : Math.round(baseCent * 0.018);
  const difalDestCent = interna ? 0 : Math.round(baseCent * 0.042);
  const creditoIcmsCent = Math.round(productosCent * 0.07);
  const issCent = Math.round(freteCent * 0.05);
  const csllCent = Math.round(baseCent * 0.009);

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
      address: direccion(r),
    },

    counterparty: {
      cnpj: digitos(r, 14),
      ie: digitos(r, 9),
      legal_name: 'Distribuidora Sul SA',
      uf: ufDestino,
      address: direccion(r),
    },

    document: {
      model: '55',
      series: '003',
      number: String(1_000_000 + indice).slice(-9).padStart(9, '0'),
      access_key: digitos(r, 44),          // 44 digitos: SIEMPRE string
      issued_at: fechaCanaria,
      operation: 'saida',
      cfop: ufOrigem === ufDestino ? '5102' : '6102',
      nature: 'Venda de mercadoria',
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

    // Tributos que no entran en `totals`: sustitucion tributaria, fondo de
    // pobreza, DIFAL y las retenciones. Todos STRING (regla 1 de CLAUDE.md).
    taxes: {
      regime: 'lucro_real',
      icms_st: brl(icmsStCent),
      fcp: brl(fcpCent),
      difal_origin: brl(difalOrigCent),
      difal_dest: brl(difalDestCent),
      icms_credit: brl(creditoIcmsCent),
      iss: brl(issCent),
      csll: brl(csllCent),
    },

    // Acuse de la SEFAZ. `authorized_at` lleva la fecha canaria de 24
    // caracteres igual que occurred_at: es contenido de la plantilla, no una
    // marca de medicion — esas viven en columnas del outbox (regla 8).
    authorization: {
      protocol: digitos(r, 15),
      status: 'autorizado',
      authorized_at: fechaCanaria,
      digest: b64det(r, 12),
      receipt: digitos(r, 15),
    },

    references: {
      purchase_order: `PO-${digitos(r, 8)}`,
      contract: `CT-${digitos(r, 6)}`,
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
