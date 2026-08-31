import { ApiProperty } from '@nestjs/swagger';

/**
 * O-07 · lo que responde `GET /health`.
 *
 * ⚠ El orquestador es el UNICO de los cuatro cuyo `ok` no mira una base: no
 * tiene. Su dependencia dura es el pool de plantillas — sin el no hay nada que
 * ofrecer— y los tenants, que NO se consultan desde aqui a proposito: pegarles
 * un health cada vez que alguien sondea este endpoint le anadiria trafico a la
 * prueba y el arnes acabaria midiendose a si mismo.
 *
 * Para saber si los destinos contestan estan sus propios `/health`
 * (`localhost:3001/health`, `:3002/health`) o `sh start --estado`.
 */
export class SaludOrqDto {
  @ApiProperty({
    example: true,
    description:
      'Hay plantillas en el pool. Con el pool vacio el orquestador arranca igual pero ' +
      'no puede materializar un solo documento: la corrida daria 0 ofrecidos sin un ' +
      'error visible.',
  })
  ok!: boolean;

  @ApiProperty({ example: 512, description: 'Plantillas cargadas. Cada envio refresca `event_id`, `rpf_id`, `sequence` y `occurred_at` (regla 11).' })
  plantillas!: number;

  @ApiProperty({ example: false, description: 'Si hay una corrida en curso. El contenedor arranca vacio y esperando: los batches se piden por `POST /batch`.' })
  corriendo!: boolean;

  @ApiProperty({ example: 2, description: 'Destinos configurados en `config/tenants.yaml`. NO se consultan desde aqui: el arnes no debe medirse a si mismo.' })
  destinos!: number;
}
