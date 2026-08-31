/**
 * C-02 · Canonical Mapper.
 *
 * Convierte el documento que llega del orquestador en los BYTES EXACTOS que se
 * van a firmar. Tres pasos, en este orden y no en otro:
 *
 *   1. validar    la forma contra CONTRATO, y el peso contra el rango
 *   2. sustituir  party_id por el HMAC real del tenant
 *   3. canonizar  JCS RFC 8785 -> Buffer UTF-8, y de ahi el payload_hash
 *
 * EL ORDEN NO ES NEGOCIABLE. `party_id` es un campo del payload, asi que
 * entra en lo que se canoniza y se firma. Sustituirlo despues de canonizar
 * dejaria la firma cubriendo el placeholder, y C4 la rechazaria con
 * `firma_invalida` — indistinguible de una inyeccion, DLQ y alarma. El
 * `payload_hash` tiene el mismo problema: sale del canonico en claro, asi que
 * calcularlo antes de la sustitucion daria una llave que no corresponde al
 * documento que viajo, y la conciliacion outbox-inbox de P4 no cerraria.
 *
 * ⚠ SIN I/O, A PROPOSITO. El HMAC entra como parametro; el mapper no lo pide.
 * Es constante por tenant -una llamada a KMS al arrancar, cacheada- asi que
 * hacerlo async no compraria nada y costaria dos cosas: los vectores fijos
 * dejarian de poder escribirse contra una funcion pura, y el paso mas caliente
 * del pipeline arrastraria un cliente de AWS que no usa.
 */
import { Injectable } from '@nestjs/common';
import { canonicalize } from '../comun/jcs';
import { payloadHash } from './hashing';
import {
  CONTRATO,
  PARTY_ID_LARGO,
  esBloque,
  esLista,
  type Campo,
  type Nodo,
} from './contrato';

/** Un documento que paso el mapper y esta listo para firmar. */
export interface Canonizado {
  /** Exactamente lo que va a `KMS Sign`. */
  canonico: Buffer;
  /** El payload con el party_id real. Es lo que se cifra junto a la firma. */
  payload: Record<string, unknown>;
  /** SHA-256 del canonico EN CLARO (paso ②). Es tambien el dedup de SQS. */
  payloadHash: string;
  /** HMAC-SHA256 del participante (paso ②), tal como quedo en el payload. */
  partyId: string;
  rpfId: string;
  eventId: string;
  sequence: number;
  /** Tamano canonico en BYTES. Nunca `.length` (regla 10). */
  bytes: number;
}

/** Por que se rechazo un documento. El motivo viaja al orquestador. */
export class DocumentoInvalido extends Error {
  constructor(
    readonly motivo: string,
    readonly campo: string,
    detalle: string,
  ) {
    super(`${campo}: ${detalle}`);
  }
}

/**
 * Rango de tamano canonico aceptado, en bytes.
 *
 * Los defaults son MAS ANCHOS que lo que el orquestador emite hoy
 * (`pool.tamano_bytes: [1536, 3072]`) a proposito: el mapper no esta para
 * replicar la configuracion del arnes, sino para atrapar un documento
 * absurdo. Si algun dia se quiere que la corrida falle cuando el tamano se
 * sale de su propio rango, se aprieta con estas dos variables.
 *
 * Para calibrar el minimo: el ejemplo de docs/ con el relleno vaciado pesa
 * 1.588 bytes, y el piso duro medido -un documento de un solo item- son
 * 1.433. Un minimo de 1.024 queda por debajo de los dos, asi que no puede
 * rechazar un documento bien formado por chico.
 */
const BYTES_MIN = Number(process.env.C3_BYTES_MIN ?? 1024);
const BYTES_MAX = Number(process.env.C3_BYTES_MAX ?? 4096);

/**
 * Techo absoluto, no configurable.
 *
 * SQS corta en 256 KB y el sobre crece sobre el canonico: firma de 64 B, IV,
 * tag, la `edk`, y el ~33% de base64 sobre todo el ciphertext. 180 KB de
 * canonico dan de sobra por debajo del limite. Un documento mas grande que
 * esto no se puede publicar, asi que firmarlo seria trabajo tirado — y peor,
 * moriria recien en el relay, con la fila ya escrita en el outbox.
 */
const BYTES_TECHO = 180_000;

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RE_DIGITOS = /^\d+$/;
const RE_DECIMAL = /^-?\d+\.\d+$/;
const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const RE_HMAC = /^hmac:[0-9a-f]{64}$/i;
const RE_B64 = /^[A-Za-z0-9+/]*$/;

@Injectable()
export class MapperService {
  /**
   * El rango se inyecta en vez de leerse del entorno dentro del metodo: un
   * limite que solo se puede mover con una variable de entorno es un limite
   * que los tests no pueden ejercitar, y un guardarrail sin test es un
   * guardarrail que nadie sabe si funciona.
   */
  constructor(
    private readonly bytesMin: number = BYTES_MIN,
    private readonly bytesMax: number = BYTES_MAX,
  ) {}

  /**
   * @param doc     el documento tal como llego, sin tocar
   * @param partyId el HMAC-SHA256 real del participante, 69 caracteres
   */
  canonizar(doc: unknown, partyId: string): Canonizado {
    if (partyId.length !== PARTY_ID_LARGO) {
      // No es culpa del documento: es un error de configuracion de C3. Si se
      // dejara pasar, TODOS los eventos de este contenedor pesarian distinto
      // de lo que declaran y la medicion entera seria mentira.
      throw new Error(
        `party_id de ${partyId.length} caracteres; el contrato fija ${PARTY_ID_LARGO}. ` +
          `Un largo distinto corre el tamano canonico que el orquestador ya ajusto al byte.`,
      );
    }

    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
      throw new DocumentoInvalido('no_es_objeto', '(raiz)', `llego un ${tipoDe(doc)}`);
    }

    const entrada = doc as Record<string, unknown>;

    // 1 · la forma. Se valida ANTES de sustituir nada: si el documento no
    // cumple, no se gasta ni el reemplazo del party_id.
    for (const [nombre, nodo] of Object.entries(CONTRATO)) {
      validarNodo(entrada[nombre], nodo, nombre);
    }

    // 2 · el party_id real. Copia superficial: el objeto de entrada es del
    // llamante y mutarlo haria que un reintento viera un documento ya tocado.
    const payload: Record<string, unknown> = { ...entrada, party_id: partyId };

    // 3 · el canonico, y de ahi todo lo demas.
    const texto = canonicalize(payload);
    const canonico = Buffer.from(texto, 'utf8');
    const bytes = canonico.length;

    if (bytes > BYTES_TECHO) {
      throw new DocumentoInvalido(
        'excede_sqs',
        '(raiz)',
        `${bytes} bytes canonicos; el techo publicable es ${BYTES_TECHO}`,
      );
    }
    if (bytes < this.bytesMin || bytes > this.bytesMax) {
      throw new DocumentoInvalido(
        'peso_fuera_de_rango',
        '(raiz)',
        `${bytes} bytes canonicos, fuera de [${this.bytesMin}, ${this.bytesMax}]`,
      );
    }

    return {
      canonico,
      payload,
      payloadHash: payloadHash(payload),
      partyId,
      rpfId: entrada['rpf_id'] as string,
      eventId: entrada['event_id'] as string,
      sequence: entrada['sequence'] as number,
      bytes,
    };
  }
}

/** Un campo, un bloque o una lista. Recursivo por la rama de bloque. */
function validarNodo(valor: unknown, nodo: Nodo, ruta: string): void {
  if (esBloque(nodo)) {
    if (valor === undefined) throw new DocumentoInvalido('campo_faltante', ruta, 'no viene');
    if (valor === null || typeof valor !== 'object' || Array.isArray(valor)) {
      throw new DocumentoInvalido('tipo_incorrecto', ruta, `esperaba un objeto, llego ${tipoDe(valor)}`);
    }
    const obj = valor as Record<string, unknown>;
    for (const [nombre, campo] of Object.entries(nodo.campos)) {
      validarCampo(obj[nombre], campo, `${ruta}.${nombre}`);
    }
    return;
  }

  if (esLista(nodo)) {
    if (valor === undefined) throw new DocumentoInvalido('campo_faltante', ruta, 'no viene');
    if (!Array.isArray(valor)) {
      throw new DocumentoInvalido('tipo_incorrecto', ruta, `esperaba un array, llego ${tipoDe(valor)}`);
    }
    if (valor.length < nodo.minimo) {
      throw new DocumentoInvalido(
        'lista_vacia',
        ruta,
        `${valor.length} elementos, el minimo es ${nodo.minimo}`,
      );
    }
    valor.forEach((elem, i) => {
      if (elem === null || typeof elem !== 'object' || Array.isArray(elem)) {
        throw new DocumentoInvalido('tipo_incorrecto', `${ruta}[${i}]`, `llego ${tipoDe(elem)}`);
      }
      const obj = elem as Record<string, unknown>;
      for (const [nombre, campo] of Object.entries(nodo.campos)) {
        validarCampo(obj[nombre], campo, `${ruta}[${i}].${nombre}`);
      }
    });
    return;
  }

  validarCampo(valor, nodo, ruta);
}

function validarCampo(valor: unknown, campo: Campo, ruta: string): void {
  if (valor === undefined) {
    throw new DocumentoInvalido('campo_faltante', ruta, `no viene${campo.nota ? ` (${campo.nota})` : ''}`);
  }
  if (valor === null) {
    // Un null se canoniza como `null` y se firma sin chistar. Se rechaza
    // aparte de "faltante" porque la causa es distinta: faltante suele ser un
    // emisor que no lo manda, null suele ser una columna vacia en su base.
    throw new DocumentoInvalido('campo_nulo', ruta, 'llego null');
  }

  switch (campo.tipo) {
    case 'entero':
      // El UNICO tipo donde se acepta un number.
      if (typeof valor !== 'number' || !Number.isInteger(valor)) {
        throw new DocumentoInvalido('tipo_incorrecto', ruta, `esperaba un entero, llego ${tipoDe(valor)}`);
      }
      return;

    case 'decimal':
      // ⚠ ESTE ES EL CHEQUEO QUE JUSTIFICA TODO EL MODULO.
      // Un importe como number se canoniza, se firma y verifica perfectamente:
      // no lo atrapa nadie mas abajo. Ver la cabecera de contrato.ts.
      if (typeof valor === 'number') {
        throw new DocumentoInvalido(
          'importe_no_es_string',
          ruta,
          `llego el number ${valor}; los importes son string o JCS los serializa como doubles (regla 1)`,
        );
      }
      exigirTexto(valor, ruta);
      if (!RE_DECIMAL.test(valor)) {
        throw new DocumentoInvalido('formato_invalido', ruta, `'${recortar(valor)}' no es un decimal`);
      }
      return;

    case 'uuid':
      exigirTexto(valor, ruta);
      if (!RE_UUID.test(valor)) {
        throw new DocumentoInvalido('formato_invalido', ruta, `'${recortar(valor)}' no es un UUID`);
      }
      return;

    case 'digitos':
      if (typeof valor === 'number') {
        throw new DocumentoInvalido(
          'digitos_no_es_string',
          ruta,
          `llego el number ${valor}; como number pierde los ceros a la izquierda y, con 44 digitos, precision`,
        );
      }
      exigirTexto(valor, ruta);
      if (!RE_DIGITOS.test(valor)) {
        throw new DocumentoInvalido('formato_invalido', ruta, `'${recortar(valor)}' no es solo digitos`);
      }
      if (campo.largo !== undefined && valor.length !== campo.largo) {
        throw new DocumentoInvalido(
          'largo_incorrecto',
          ruta,
          `${valor.length} digitos, el contrato fija ${campo.largo}`,
        );
      }
      return;

    case 'iso8601':
      exigirTexto(valor, ruta);
      // Se valida que sea parseable, no el formato exacto: los emisores
      // varian en la precision de los milisegundos y en como escriben la zona.
      if (Number.isNaN(Date.parse(valor))) {
        throw new DocumentoInvalido('formato_invalido', ruta, `'${recortar(valor)}' no es una fecha ISO 8601`);
      }
      return;

    case 'fecha':
      exigirTexto(valor, ruta);
      if (!RE_FECHA.test(valor)) {
        throw new DocumentoInvalido('formato_invalido', ruta, `'${recortar(valor)}' no es YYYY-MM-DD`);
      }
      return;

    case 'party_id':
      exigirTexto(valor, ruta);
      // Aca se valida el que LLEGO (el placeholder del orquestador), no el que
      // C3 va a poner. Los dos tienen que medir 69: si el entrante midiera
      // otra cosa, el ajuste de tamano del orquestador ya estaria roto y
      // conviene enterarse aca y no en la conciliacion de bytes.
      if (!RE_HMAC.test(valor)) {
        throw new DocumentoInvalido('formato_invalido', ruta, `'${recortar(valor)}' no es 'hmac:' + 64 hex`);
      }
      return;

    case 'relleno':
      exigirTexto(valor, ruta);
      // Alfabeto base64 sin '=': es ASCII puro, asi que 1 caracter = 1 byte y
      // el ajuste al byte del orquestador sale exacto (PL-01).
      if (!RE_B64.test(valor)) {
        throw new DocumentoInvalido('formato_invalido', ruta, 'el relleno tiene caracteres fuera de base64');
      }
      return;

    case 'texto':
      exigirTexto(valor, ruta);
      if (valor.length === 0) {
        throw new DocumentoInvalido('campo_vacio', ruta, 'texto vacio');
      }
      return;
  }
}

function exigirTexto(valor: unknown, ruta: string): asserts valor is string {
  if (typeof valor !== 'string') {
    throw new DocumentoInvalido('tipo_incorrecto', ruta, `esperaba un string, llego ${tipoDe(valor)}`);
  }
}

function tipoDe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/** Los mensajes de error van al log y al cuerpo de la respuesta: no vuelcan 3 KB. */
const recortar = (s: string): string => (s.length <= 40 ? s : `${s.slice(0, 40)}…`);
