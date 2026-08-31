import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Los DTO existen para DOCUMENTAR, no para validar.
 *
 * La validacion de verdad vive en `CorridaService.preparar()`, que es la misma
 * que atraviesa el perfil del YAML. Duplicarla aqui con class-validator daria
 * dos fuentes de verdad que se desincronizarian, y perderia los mensajes que
 * explican POR QUE algo no vale ("client '99' no existe. Hay 2: 1=tenant-01,
 * 2=tenant-02").
 */

export class RangoDto {
  @ApiProperty({ example: 20, description: 'Minimo, inclusive.' })
  min!: number;

  @ApiProperty({ example: 60, description: 'Maximo, inclusive.' })
  max!: number;
}

export class RequestDto {
  @ApiPropertyOptional({
    type: RangoDto,
    description:
      'PETICIONES HTTP por cliente y por segundo. Cada segundo se sortea un ' +
      'numero nuevo dentro del rango, asi la carga varia en vez de ser plana.\n\n' +
      '⚠ Cuenta PETICIONES, no eventos. Cuantos documentos lleva cada una lo ' +
      'decide `events`. eventos/s = peticiones/s x documentos por peticion.',
    example: { min: 20, max: 60 },
  })
  client?: RangoDto;
}

export class EventsDto {
  @ApiPropertyOptional({
    type: RangoDto,
    description:
      'DOCUMENTOS dentro de cada peticion. Se sortea uno POR PETICION, no uno ' +
      'por segundo: dos peticiones del mismo segundo pueden llevar 3 y 9.\n\n' +
      'Si se omite, el tamaño es fijo y lo fija `perRequest` (por defecto 1).',
    example: { min: 1, max: 10 },
  })
  client?: RangoDto;
}

export class LanzarBatchDto {
  @ApiPropertyOptional({
    example: 'xxt',
    description:
      'Identificador de la corrida. Da nombre a los logs de LOS DOS lados: ' +
      'orquestador/logs/<id>.json y c3/logs/<id>__<tenant>.json. ' +
      'Si se omite se genera uno con la fecha. Un id ya usado se rechaza con 409 ' +
      'en vez de sobrescribir el informe anterior.',
  })
  id?: string;

  @ApiPropertyOptional({
    example: 'all',
    description:
      'A quien pegarle: "all", el id del tenant ("tenant-02"), o su indice ' +
      'empezando en 1 (acepta 1 y "1"). Por defecto, todos.',
  })
  client?: string | number;

  @ApiPropertyOptional({ example: 20, description: 'Duracion de la corrida en segundos.' })
  seconds?: number;

  @ApiPropertyOptional({
    type: RequestDto,
    description:
      'Rango de eventos por CLIENTE y por SEGUNDO. Cada segundo se sortea un ' +
      'entero dentro del rango y ese es el numero exacto que sale. ⚠ Gobierna ' +
      'cuando el evento SALE, no cuando el destino contesta. Excluyente con ' +
      'rate y con events.',
    example: { client: { min: 20, max: 60 } },
  })
  request?: RequestDto;

  @ApiPropertyOptional({
    example: 40,
    description: 'Ritmo PLANO en eventos/s por tenant. Excluyente con request y events.',
  })
  rate?: number;

  @ApiPropertyOptional({
    description:
      'DOS SIGNIFICADOS, segun la forma:\n\n' +
      '• `2500` (numero) — TOTAL de eventos a repartir en la ventana, con un ' +
      'numero aleatorio de llamadas por tenant. Excluyente con `rate` y `request`.\n\n' +
      '• `{ "client": { "min": 1, "max": 10 } }` (objeto) — DOCUMENTOS POR ' +
      'PETICION. COMPLEMENTA a `request` en vez de excluirlo: uno fija cuantas ' +
      'peticiones salen y el otro cuanto lleva cada una.',
    oneOf: [{ type: 'number', example: 2500 }, { $ref: '#/components/schemas/EventsDto' }],
    example: { client: { min: 1, max: 10 } },
  })
  events?: number | EventsDto;

  @ApiPropertyOptional({
    example: 1,
    description:
      'Tamaño FIJO del lote, en documentos por peticion. Es el atajo para ' +
      '`events: { client: { min: N, max: N } }`; si mandas `events` como objeto, ' +
      'este se ignora.',
  })
  perRequest?: number;

  @ApiPropertyOptional({
    example: 0,
    description:
      'Tope de requests en vuelo por tenant. 0 = SIN TOPE, y es lo correcto por ' +
      'defecto: un tope es un lazo cerrado que frena el envio segun lo rapido que ' +
      'conteste el destino, justo lo que O-02 prohibe. Ponlo solo como valvula de ' +
      'seguridad; el informe lo delata en dropped_saturation.',
  })
  concurrency?: number;

  @ApiPropertyOptional({ example: 5000, description: 'Timeout HTTP en milisegundos.' })
  timeout?: number;

  @ApiPropertyOptional({
    enum: ['poisson', 'uniforme'],
    example: 'poisson',
    description:
      'Distribucion de las llegadas. Poisson produce rafagas — y son las rafagas ' +
      'las que llenan el outbox. Uniforme es trafico de laboratorio.',
  })
  arrivals?: 'poisson' | 'uniforme';

  @ApiPropertyOptional({
    enum: ['zipf', 'uniforme'],
    example: 'zipf',
    description:
      'Reparto entre tenants. Zipf es ley de potencias, como el trafico real. ' +
      'Con reparto uniforme ningun tenant alcanza los 300 msg/s por MessageGroupId ' +
      'y la prueba nunca toca el limite que quiere medir (D-06).',
  })
  spread?: 'zipf' | 'uniforme';

  @ApiPropertyOptional({
    example: 1,
    description:
      'Eventos que comparten rpf_id, es decir MessageGroupId. Con 1, paralelismo ' +
      'maximo en la cola. Con 50, orden estricto por expediente. Es la perilla de D-06.',
  })
  thread?: number;

  @ApiPropertyOptional({
    example: 20260830,
    description: 'Semilla del PRNG. Misma semilla, mismas plantillas. Reconstruye el pool.',
  })
  seed?: number;

  @ApiPropertyOptional({
    type: [Number],
    example: [2048, 4096],
    description:
      'Rango [min, max] del tamaño canonico en bytes. El piso real del documento ' +
      'fiscal es 2024 (1864 sin items); por debajo se rechaza. Reconstruye el pool.',
  })
  size?: [number, number];

  @ApiPropertyOptional({
    type: [Number],
    example: [1, 5],
    description: 'Rango [min, max] de items por documento. Reconstruye el pool.',
  })
  items?: [number, number];

  @ApiPropertyOptional({ example: 1000, description: 'Plantillas pre-generadas. Reconstruye el pool.' })
  pool?: number;

  @ApiPropertyOptional({
    example: 0.01,
    description:
      'Fraccion de eventos a los que se les comprueba el tamaño canonico. ' +
      '1 = todos (correcto pero caro), 0 = solo al construir el pool.',
  })
  verify?: number;
}
