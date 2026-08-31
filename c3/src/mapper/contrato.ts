/**
 * EL CONTRATO DEL PAYLOAD — todos los atributos que C3 exige.
 *
 * Esta es la plantilla contra la que C-02 valida cada documento que llega del
 * orquestador. Describe la forma de docs/02-payload.md y coincide campo por
 * campo con lo que el generador emite HOY
 * (`orquestador/src/generador/payload.ts` y `docs/payload-ejemplo.json`), asi
 * que con el trafico actual no rechaza nada. Eso es a proposito: se quiere que
 * el camino de fallo exista y este probado, no que se dispare en la primera
 * corrida.
 *
 * POR QUE VALIDAR ANTES DE FIRMAR, y no dejar que C4 se entere:
 *
 * C3 firma cualquier cosa que le den. Un documento al que le falta `totals` se
 * canoniza igual, se firma igual y viaja igual — y muere del otro lado, en C4,
 * con `firma_invalida` o con un INSERT que revienta. A 2.000 ev/s el sintoma
 * llega a la DLQ con alarma, en otra cuenta de AWS, sin el `event_id` a mano y
 * sin manera de saber que tenant lo produjo. Validar aca cuesta microsegundos
 * y convierte ese incidente en un descarte con nombre y motivo.
 *
 * LA REGLA QUE DE VERDAD IMPORTA: `importe` es SIEMPRE string.
 *
 * JCS serializa los numeros con Number::toString de ECMAScript. Un importe que
 * llegue como `1234.5` en vez de `"1234.50"` se canoniza como `1234.5`, se
 * firma perfectamente y verifica perfectamente — o sea que no lo atrapa nadie
 * mas abajo. El dia que ese mismo importe pase por un lenguaje con otro
 * formato de doble, el canonico cambia y la firma deja de verificar. Es la
 * regla 1 de CLAUDE.md y es la unica que puede romper la PoC en silencio.
 *
 * Lo que este archivo NO hace: no valida reglas de negocio. Que `totals.total`
 * cuadre con la suma de los items es problema del emisor, no de C3. C3 es un
 * notario: certifica que el documento tiene la forma acordada y lo firma tal
 * como vino.
 */

/** Los tipos que sabe validar el mapper. */
export type Tipo =
  /** UUID en cualquier version. */
  | 'uuid'
  /** Texto no vacio, sin mas. */
  | 'texto'
  /** Entero. Es el UNICO sitio donde se acepta un `number`. */
  | 'entero'
  /**
   * Importe o cantidad decimal, SIEMPRE como string: `"18920.50"`.
   * Ver la nota de arriba: es la regla que rompe la PoC en silencio.
   */
  | 'decimal'
  /** Solo digitos, como string. `largo` fija cuantos. */
  | 'digitos'
  /** Marca de tiempo ISO 8601 con zona. */
  | 'iso8601'
  /** Fecha `YYYY-MM-DD`, sin hora. */
  | 'fecha'
  /** `hmac:` + 64 hex. Largo fijo 69; ver la nota en `PARTY_ID_LARGO`. */
  | 'party_id'
  /** Relleno base64 para el ajuste de tamano. Puede ser vacio. */
  | 'relleno';

export interface Campo {
  tipo: Tipo;
  /** Numero exacto de digitos, solo para `digitos`. */
  largo?: number;
  /** Para que sirve. Sale en el mensaje de error. */
  nota?: string;
}

/** Un objeto anidado: `participant`, `totals`, `document`… */
export interface Bloque {
  clase: 'bloque';
  campos: Record<string, Campo>;
  nota?: string;
}

/** Una lista de objetos: `items`. */
export interface Lista {
  clase: 'lista';
  minimo: number;
  campos: Record<string, Campo>;
  nota?: string;
}

export type Nodo = Campo | Bloque | Lista;

export const esBloque = (n: Nodo): n is Bloque => (n as Bloque).clase === 'bloque';
export const esLista = (n: Nodo): n is Lista => (n as Lista).clase === 'lista';

/**
 * `party_id` — `hmac:` + 64 hex, 69 caracteres EXACTOS.
 *
 * Es el artefacto del paso ② del pipeline RPF: HMAC-SHA256 del identificador
 * del participante. 64 hex porque el HMAC va COMPLETO, sin truncar — truncarlo
 * a la mitad lo apartaria del protocolo sin ahorrar nada que importe.
 *
 * El orquestador manda un placeholder de ese largo exacto y C3 lo sustituye
 * por el HMAC real de `KMS_HMAC_KEY_ID`. Si el reemplazo midiera otra cosa, el
 * documento dejaria de pesar lo que su plantilla declara: el orquestador
 * ajusto el `padding` al byte contra el tamano objetivo, y mover el `party_id`
 * corre ese numero. La prueba seguiria corriendo y los bytes reportados serian
 * mentira.
 */
export const PARTY_ID_PREFIJO = 'hmac:';
export const PARTY_ID_HEX = 64;
export const PARTY_ID_LARGO = PARTY_ID_PREFIJO.length + PARTY_ID_HEX; // 69

/**
 * EL CONTRATO. Cada clave de primer nivel es un bloque de docs/02-payload.md.
 *
 * El orden en que estan escritas no importa —JCS ordena las claves antes de
 * serializar— pero se respeta el del documento para que se lean en paralelo.
 */
export const CONTRATO: Record<string, Nodo> = {
  // ── identidad ─────────────────────────────────────────────────────────────
  // Estos cinco los decide el ORQUESTADOR, no C3 (cambio de diseno vigente).
  // C3 los recibe hechos y solo comprueba que tengan la forma acordada.
  rpf_id: { tipo: 'uuid', nota: 'identificador del expediente; es el MessageGroupId de SQS' },
  event_id: { tipo: 'uuid', nota: 'identificador del evento' },
  event_type: { tipo: 'texto' },
  schema_version: { tipo: 'texto' },
  occurred_at: { tipo: 'iso8601' },
  sequence: { tipo: 'entero', nota: 'orden dentro del rpf_id; C4 detecta huecos con esto' },
  party_id: { tipo: 'party_id', nota: 'HMAC-SHA256 del participante; lo escribe C3 antes de canonizar' },

  // ── partes ────────────────────────────────────────────────────────────────
  participant: {
    clase: 'bloque',
    nota: 'el emisor: el tenant',
    campos: {
      cnpj: { tipo: 'digitos', largo: 14 },
      ie: { tipo: 'digitos', nota: 'inscricao estadual; el largo varia por UF' },
      legal_name: { tipo: 'texto' },
      municipality_code: { tipo: 'digitos', largo: 7 },
      uf: { tipo: 'texto' },
    },
  },

  counterparty: {
    clase: 'bloque',
    nota: 'el receptor',
    campos: {
      cnpj: { tipo: 'digitos', largo: 14 },
      ie: { tipo: 'digitos' },
      legal_name: { tipo: 'texto' },
      uf: { tipo: 'texto' },
    },
  },

  // ── el documento fiscal ───────────────────────────────────────────────────
  document: {
    clase: 'bloque',
    campos: {
      model: { tipo: 'texto' },
      series: { tipo: 'texto' },
      number: { tipo: 'texto' },
      // 44 digitos como STRING. Como numero perderia precision -supera los
      // 2^53 de un doble- y ademas se le comerian los ceros de la izquierda.
      access_key: { tipo: 'digitos', largo: 44, nota: 'chave de acesso; string, nunca number' },
      issued_at: { tipo: 'iso8601' },
      operation: { tipo: 'texto' },
      cfop: { tipo: 'texto' },
      nature: { tipo: 'texto' },
    },
  },

  // ── importes ──────────────────────────────────────────────────────────────
  // TODO string salvo items_count. Ver la nota de cabecera.
  totals: {
    clase: 'bloque',
    campos: {
      items_count: { tipo: 'entero' },
      products: { tipo: 'decimal' },
      discount: { tipo: 'decimal' },
      freight: { tipo: 'decimal' },
      tax_base: { tipo: 'decimal' },
      icms: { tipo: 'decimal' },
      ipi: { tipo: 'decimal' },
      pis: { tipo: 'decimal' },
      cofins: { tipo: 'decimal' },
      total: { tipo: 'decimal' },
    },
  },

  items: {
    clase: 'lista',
    minimo: 1,
    nota: 'las lineas del documento; el orden SI importa y JCS no lo toca',
    campos: {
      line: { tipo: 'entero' },
      code: { tipo: 'texto' },
      description: { tipo: 'texto' },
      ncm: { tipo: 'digitos' },
      unit: { tipo: 'texto' },
      // Decimales de largo variable a proposito: quantity trae 3 y unit_price
      // 4. No se fija el numero porque es cosa del emisor; lo que si se fija
      // es que sean string.
      quantity: { tipo: 'decimal' },
      unit_price: { tipo: 'decimal' },
      total: { tipo: 'decimal' },
    },
  },

  // ── el resto ──────────────────────────────────────────────────────────────
  transport: {
    clase: 'bloque',
    campos: {
      mode: { tipo: 'texto' },
      carrier_cnpj: { tipo: 'digitos', largo: 14 },
      vehicle_plate: { tipo: 'texto' },
      gross_weight: { tipo: 'decimal' },
    },
  },

  payment: {
    clase: 'bloque',
    campos: {
      method: { tipo: 'texto' },
      installments: { tipo: 'entero' },
      due_first: { tipo: 'fecha' },
    },
  },

  origin: {
    clase: 'bloque',
    campos: {
      system: { tipo: 'texto' },
      version: { tipo: 'texto' },
      environment: { tipo: 'texto' },
    },
  },

  // El relleno con el que el orquestador ajusta el tamano canonico al byte.
  // Se firma como todo lo demas, pero su CONTENIDO da igual: por eso es el
  // unico campo donde el orquestador puede usar aleatoriedad sin romper la
  // regla 9.
  padding: { tipo: 'relleno', nota: 'ajuste de tamano; solo importa su largo' },
};

/** Los campos de primer nivel, para mensajes de error y para los tests. */
export const CAMPOS_RAIZ = Object.keys(CONTRATO);
