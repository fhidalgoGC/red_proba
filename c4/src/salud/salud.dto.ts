import { ApiProperty } from '@nestjs/swagger';

/** Los contadores del lazo. Se resetean con el proceso, no con la corrida. */
export class ContadoresDto {
  @ApiProperty({ description: 'Mensajes sacados de la cola.' }) recibidos!: number;
  @ApiProperty({ description: 'Mensajes borrados tras procesarlos.' }) borrados!: number;
  @ApiProperty({
    description:
      'DeleteMessageBatch que fallaron. ⚠ Cada uno reaparece al vencer el visibility ' +
      'timeout y se reprocesa: se veran como duplicados, no como error.',
  })
  fallos_borrado!: number;
  @ApiProperty({ description: 'Vueltas del lazo.' }) ciclos!: number;
  @ApiProperty({ description: 'Vueltas que no trajeron nada.' }) ciclos_vacios!: number;
  @ApiProperty({ description: 'Errores de ReceiveMessage.' }) errores!: number;
  @ApiProperty({ description: 'Bytes de cuerpo recibidos.' }) bytes!: number;
}

export class ConsumidorDto {
  @ApiProperty({
    description:
      '⚠ `false` con el proceso vivo es un consumidor que YA PARO —por ' +
      '`C4_SALIR_TRAS_VACIOS` o por un cierre en curso— y no esta consumiendo nada. ' +
      'Desde fuera, sin esto, es indistinguible de uno trabajando.',
  })
  corriendo!: boolean;

  @ApiProperty({ description: 'Ciclos vacios seguidos. Con `C4_SALIR_TRAS_VACIOS` es la cuenta atras.' })
  vacios_seguidos!: number;

  @ApiProperty({ type: ContadoresDto }) contadores!: ContadoresDto;
}

export class SaludDto {
  @ApiProperty({
    description:
      '⚠ Refleja LA BASE, no el proceso. C4 puede estar vivo con el Postgres caido y ' +
      'seguir sacando mensajes de la cola: los borraria sin persistir y P4 daria de ' +
      'menos, sin un solo error. Decir `ok:true` ahi seria mentir.',
  })
  ok!: boolean;

  @ApiProperty({ description: 'Resultado del `SELECT 1` contra el Postgres de C4.' })
  base!: boolean;

  @ApiProperty({ example: 'operador-neutro' }) rol!: string;

  @ApiProperty({
    description:
      'Siempre `false`, y esta escrito y no deducido. **C4 descifra y verifica pero NO ' +
      'firma** (regla 7): es el invariante del Proof Ledger. Lo sostienen las policies ' +
      'de KMS; aqui queda a la vista.',
    example: false,
  })
  puede_firmar!: boolean;

  @ApiProperty({ example: 'c4' }) esquema!: string;
  @ApiProperty({ description: 'La cola FIFO de la que consume. Su UNICA entrada (D-03).' }) cola!: string;
  @ApiProperty({ nullable: true, description: 'Sin DLQ el veneno se cuenta y se borra, sin dejar evidencia.' })
  dlq!: string | null;
  @ApiProperty({ example: 'us-west-2' }) region!: string;

  @ApiProperty({
    description:
      'Cuantos `key_id` acepta. **0 = acepta cualquiera**: la firma probaria integridad ' +
      'pero no autoria.',
  })
  llaves_firma_aceptadas!: number;

  @ApiProperty({ type: ConsumidorDto }) consumidor!: ConsumidorDto;
}

export class StatusDto {
  @ApiProperty({ example: 'operador-neutro' }) rol!: string;
  @ApiProperty({ type: ConsumidorDto }) consumidor!: ConsumidorDto;
}
