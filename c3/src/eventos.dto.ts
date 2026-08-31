import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Los DTO existen para DOCUMENTAR, no para validar.
 *
 * La validacion de verdad vive en `MapperService`, que recorre el contrato de
 * `mapper/contrato.ts` campo por campo y devuelve un descarte con motivo,
 * campo y detalle. Duplicarla aqui con class-validator daria dos fuentes de
 * verdad que se desincronizarian, y perderia los mensajes que explican POR QUE
 * algo no vale ("totals.total: '1234.5' no es un decimal").
 *
 * Hay una razon mas, y es especifica de C3: un ValidationPipe rechazaria el
 * LOTE ENTERO con un 400 en cuanto un solo documento viniera mal. C3 hace lo
 * contrario a proposito — cada documento se resuelve solo, los malos no tumban
 * a los buenos, y el 202 lleva `aceptados` y `descartados` por separado. Sin
 * eso, un documento invalido a 2.000 ev/s se llevaria por delante los otros 19
 * del lote y la conciliacion de P4 acusaria a la red.
 */

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------

/**
 * Un documento fiscal del contrato de `docs/02-payload.md`.
 *
 * No se declaran los ~50 campos uno a uno: la fuente de verdad es
 * `mapper/contrato.ts`, y un DTO paralelo se quedaria viejo en la primera
 * corrida. Lo que si se documenta son los cinco campos que C3 usa para
 * identificar, deduplicar y firmar, mas la regla que rompe la PoC en silencio.
 */
export class DocumentoDto {
  @ApiProperty({
    example: '018f3c2a-7b41-7c6e-9d02-4a1f8e5b3c91',
    description: 'UUID unico del evento. C3 lo usa para nombrar el descarte y para detectar duplicados.',
  })
  event_id!: string;

  @ApiProperty({
    example: '018f3c2a-7b41-7c6e-9d02-4a1f8e5b3c90',
    description:
      'Expediente. Acaba siendo el MessageGroupId de SQS FIFO, o sea que fija el ' +
      'orden y el techo de 300 msg/s por grupo (D-06).',
  })
  rpf_id!: string;

  @ApiProperty({
    example: 4821,
    description: 'Posicion dentro del rpf_id. Es el UNICO sitio, junto a los enteros de totals e items, donde se acepta un number.',
  })
  sequence!: number;

  @ApiProperty({
    example: '2026-08-29T14:32:08.412Z',
    description:
      'Cuando ocurrio el hecho de negocio, ISO 8601 con zona. ⚠ NO es una marca de ' +
      'medicion: las marcas de la PoC (e0..e6) nunca van dentro del payload porque ' +
      'el payload va firmado (regla 8).',
  })
  occurred_at!: string;

  @ApiProperty({
    example: 'hmac:' + '0'.repeat(64),
    description:
      'Paso ② del pipeline RPF · HMAC-SHA256 del participante. Llega como un ' +
      'placeholder de largo fijo (69 caracteres: `hmac:` + 64 hex) y C3 lo SUSTITUYE ' +
      'por el HMAC real de KMS antes de canonizar. El largo es fijo justamente para ' +
      'que la sustitucion no mueva el tamaño canonico que el orquestador ya conto.',
  })
  party_id!: string;

  @ApiProperty({
    example: {
      total: '18920.50',
      tax_base: '18920.50',
      icms: '2270.46',
      items_count: 2,
    },
    description:
      '⚠ TODO IMPORTE ES STRING, NUNCA number. JCS serializa los numeros con ' +
      'Number::toString de ECMAScript: `1234.5` se canoniza, se firma y verifica ' +
      'perfectamente hoy, y deja de verificar el dia que pase por un lenguaje con ' +
      'otro formato de doble. Es la regla 1 de CLAUDE.md y la unica que puede ' +
      'romper la PoC sin un solo error en los logs. Igual la access_key de 44 digitos.',
  })
  totals!: Record<string, unknown>;
}

export class LoteEntranteDto {
  @ApiPropertyOptional({
    example: '7f3a1c88-2d4e-4b91-a0f6-5e8c1b7d9a20',
    description:
      'Identifica el REQUEST, no el segundo ni nada dentro del payload. Un lote es ' +
      'un POST: los N documentos que el orquestador empaqueto juntos ' +
      '(`eventosPorRequest`, 20 por defecto, o antes si vencio la espera de 200 ms). ' +
      'Si falta, C3 cae a la cabecera `x-lote-id`. Sirve para correlacionar y nada ' +
      'mas: C3 no lo persiste y NO sobrevive al salto a C4.',
  })
  lote_id?: string;

  @ApiPropertyOptional({
    example: 'tenant-01',
    description:
      'Informativo. El tenant real de C3 sale de su propia variable TENANT_ID, no ' +
      'de lo que diga el cuerpo — si no, cualquiera podria firmar como otro.',
  })
  tenant_id?: string;

  @ApiProperty({
    type: [DocumentoDto],
    description:
      'Los documentos del lote. Cada uno es un evento INDEPENDIENTE y completo: se ' +
      'valida, firma y cifra por separado, y aguas abajo sera un mensaje de SQS ' +
      'propio. Un documento invalido no tumba a los demas.',
  })
  documentos!: DocumentoDto[];
}

// ---------------------------------------------------------------------------
// Salida
// ---------------------------------------------------------------------------

export class DescarteDto {
  @ApiProperty({
    example: '018f3c2a-7b41-7c6e-9d02-4a1f8e5b3c91',
    nullable: true,
    description: 'Puede ser null: si el documento no trae event_id, no hay nada que nombrar.',
  })
  event_id!: string | null;

  @ApiProperty({ example: 3, description: 'Posicion dentro del array `documentos` que llego.' })
  indice!: number;

  @ApiProperty({
    example: 'importe_no_es_string',
    description:
      'Que fallo. Forma: no_es_objeto, campo_faltante, campo_nulo, campo_vacio, ' +
      'tipo_incorrecto, formato_invalido, largo_incorrecto, lista_vacia. ' +
      'Regla 1: importe_no_es_string y digitos_no_es_string — son los dos que ' +
      'romperian la firma en silencio si pasaran. ' +
      'Tamaño: peso_fuera_de_rango (canonico fuera de [C3_BYTES_MIN, C3_BYTES_MAX], ' +
      '[1024, 4096] por defecto) y excede_sqs (por encima del techo publicable de ' +
      '180.000 bytes).',
  })
  motivo!: string;

  @ApiProperty({
    example: 'totals.total',
    description: 'La ruta exacta del campo culpable. Es lo que convierte un incidente en la DLQ en un descarte con nombre.',
  })
  campo!: string;
}

export class RespuestaLoteDto {
  @ApiProperty({ example: 20, description: 'Documentos que venian en el array.' })
  recibidos!: number;

  @ApiProperty({
    example: 20,
    description: 'Los que pasaron el contrato, se firmaron y se cifraron.',
  })
  aceptados!: number;

  @ApiProperty({
    type: [DescarteDto],
    description:
      'Va SEPARADO de `recibidos` a proposito. Si C3 contestara solo "recibidos" y ' +
      'se comiera los descartes en su log, la conciliacion de P4 daria un falso ' +
      'negativo sin un solo error a la vista.',
  })
  descartados!: DescarteDto[];

  @ApiProperty({ example: '7f3a1c88-2d4e-4b91-a0f6-5e8c1b7d9a20', nullable: true })
  lote_id!: string | null;

  @ApiProperty({
    example: 'abc16',
    nullable: true,
    description: 'Eco de `x-prueba-id`. Confirma con que id se estan agrupando los logs de este lado.',
  })
  prueba!: string | null;
}

export class SaludDto {
  @ApiProperty({
    example: true,
    description: 'Refleja la BASE, no el proceso (C-08). Con la base caida C3 no puede escribir el outbox y por tanto no puede entregar nada.',
  })
  ok!: boolean;

  @ApiProperty({ example: true, description: 'Si Postgres contesta. Es lo mismo que `ok`, explicito.' })
  base!: boolean;

  @ApiProperty({ example: 'tenant-01', description: 'De TENANT_ID; en local, `puerto-3001`.' })
  tenant!: string;

  @ApiProperty({
    example: { 'C-02': 'mapper', 'C-03': 'firma', 'C-04': 'cifrado', 'C-05': 'outbox', 'C-06': 'relay' },
    description: 'Que hay hecho y que no. Un health que dice `ok` sin mas invita a creer que el camino esta completo.',
  })
  tareas!: Record<string, string>;

  @ApiProperty({
    example: true,
    description: 'Desde C-06 el relay publica de verdad en la cola FIFO de C4.',
  })
  publica_a_sqs!: boolean;

  @ApiProperty({
    example: { total: 128, pendientes: 128, enviados: 0, fallidos: 0, payload_hash_unicos: 128, expedientes: 12 },
    nullable: true,
    description: 'Conteos del outbox. `pendientes` creciendo sin que `enviados` suba es exactamente lo que se espera hasta C-06. Null si la base no contesta.',
  })
  outbox!: Record<string, number> | null;

  @ApiProperty({
    example: { ticks: 412, vueltas: 500, publicados: 719, pausas: 0, purgas: 0, ocupado: false, parando: false, pausado_ms: 0, fallos_seguidos: 0 },
    description: '⚠ `ocupado: true` permanente = el relay se congelo y los eventos se acumulan en silencio. `pausado_ms > 0` = circuit breaker abierto.',
  })
  relay!: Record<string, unknown>;

  @ApiProperty({
    example: null,
    nullable: true,
    description: 'Retardo artificial activo, de C3_DELAY_MS. Perilla de prueba, no del producto.',
  })
  retardo_ms!: { min: number; max: number } | null;
}

export class PruebaResumenDto {
  @ApiProperty({ example: 'abc16' })
  prueba!: string;

  @ApiProperty({ example: 152, description: 'Requests HTTP, es decir lotes.' })
  peticiones!: number;

  @ApiProperty({ example: 3040, description: 'Documentos. Es este el numero que se resta contra el `sent` del orquestador.' })
  eventos!: number;

  @ApiProperty({ example: 7012480, description: 'Bytes de los documentos, descontado el envoltorio del lote.' })
  bytes!: number;

  @ApiProperty({ example: 2306.7, nullable: true })
  bytes_medios_por_evento!: number | null;

  @ApiProperty({ example: 3040 })
  event_ids_unicos!: number;

  @ApiProperty({
    example: 0,
    description:
      'Se comparan contra TODA la prueba, no solo contra el minuto en curso: un ' +
      'duplicado que cruza la frontera del minuto sigue siendo un duplicado, y es ' +
      'exactamente el fallo que SQS FIFO se tragaria en silencio.',
  })
  event_ids_duplicados!: number;

  @ApiProperty({ example: 3, description: 'Ventanas de un minuto ya cerradas. Los totales de arriba son la suma de estas.' })
  ventanas!: number;

  @ApiProperty({
    example: true,
    description:
      'Hay un minuto en curso cuyos numeros TODAVIA NO estan contados arriba. Con ' +
      'true, este resumen va por detras de lo que ya llego.',
  })
  minuto_abierto!: boolean;

  @ApiProperty({ example: '/app/logs/abc16__tenant-01.json' })
  archivo!: string;
}

export class StatusDto {
  @ApiProperty({ example: 'tenant-01' })
  tenant!: string;

  @ApiProperty({ example: '/app/logs', description: 'De C3_LOGS_DIR.' })
  logs!: string;

  @ApiProperty({ type: [PruebaResumenDto] })
  pruebas!: PruebaResumenDto[];
}

// ---------------------------------------------------------------------------
// Ejemplos de Swagger
// ---------------------------------------------------------------------------

/**
 * Un documento fiscal COMPLETO y VALIDO, listo para "Try it out".
 *
 * Que sea completo no es adorno: el mapper rechaza por `peso_fuera_de_rango`
 * todo lo que caiga fuera de [C3_BYTES_MIN, C3_BYTES_MAX] = [1024, 4096] por
 * defecto. Un ejemplo recortado a cuatro campos daria un descarte en el primer
 * intento y el que lo probara pensaria que C3 esta roto.
 *
 * El relleno se genera con `repeat` en vez de pegar 1.514 caracteres de base64
 * real: el contrato solo exige el alfabeto base64, y asi el ejemplo se lee.
 * Sale en 3.072 bytes canonicos, el tamaño de `docs/payload-ejemplo.json`.
 */
export const EJEMPLO_DOCUMENTO = {
  schema_version: '1.4.0',
  event_id: '018f3c2a-7b41-7c6e-9d02-4a1f8e5b3c91',
  event_type: 'fiscal.document.issued',
  rpf_id: '018f3c2a-7b41-7c6e-9d02-4a1f8e5b3c90',
  sequence: 4821,
  occurred_at: '2026-08-29T14:32:08.412Z',
  party_id: 'hmac:' + '0'.repeat(64),
  participant: {
    cnpj: '12345678000195',
    ie: '110042490114',
    legal_name: 'Metalurgica Paulista Ltda',
    municipality_code: '3550308',
    uf: 'SP',
  },
  counterparty: {
    cnpj: '98765432000112',
    ie: '283194857',
    legal_name: 'Distribuidora Sul SA',
    uf: 'PR',
  },
  document: {
    // 44 digitos y COMO STRING. Igual que los importes: en number perderia
    // precision y la firma dejaria de verificar.
    access_key: '35260812345678000195550030004819271284937261',
    cfop: '6102',
    issued_at: '2026-08-29T14:31:55.000Z',
    model: '55',
    nature: 'Venda de mercadoria de terceiros',
    number: '000481927',
    operation: 'saida',
    series: '003',
  },
  items: [
    {
      line: 1,
      code: 'MP-4471-A',
      description: 'Chapa aco carbono 2.00mm',
      ncm: '72083990',
      quantity: '1250.000',
      unit: 'KG',
      unit_price: '11.4800',
      total: '14350.00',
    },
    {
      line: 2,
      code: 'MP-2210-B',
      description: 'Perfil U 100x50x3.00mm',
      ncm: '72166100',
      quantity: '340.000',
      unit: 'KG',
      unit_price: '12.0588',
      total: '4100.00',
    },
  ],
  totals: {
    cofins: '1437.96',
    discount: '350.00',
    freight: '820.50',
    icms: '2270.46',
    ipi: '922.50',
    items_count: 2,
    pis: '312.19',
    products: '18450.00',
    tax_base: '18920.50',
    total: '18920.50',
  },
  payment: { due_first: '2026-09-28', installments: 3, method: 'boleto' },
  transport: {
    carrier_cnpj: '45678901000133',
    gross_weight: '1338.400',
    mode: 'cif',
    vehicle_plate: 'BRA2E19',
  },
  origin: { environment: 'poc', system: 'erp-connector', version: '3.11.2' },
  padding: 'A'.repeat(1514),
};

/** El mismo documento con `totals.total` en number: la regla 1, rota a proposito. */
export const EJEMPLO_DOCUMENTO_INVALIDO = {
  ...EJEMPLO_DOCUMENTO,
  event_id: '018f3c2a-7b41-7c6e-9d02-4a1f8e5b3c92',
  totals: { ...EJEMPLO_DOCUMENTO.totals, total: 18920.5 },
};
