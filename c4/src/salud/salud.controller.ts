import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SaludService } from './salud.service';
import { SaludDto, StatusDto } from './salud.dto';

/**
 * G-09 · lo unico que C4 sirve por HTTP.
 *
 * No hay endpoint para consultar el ledger: los informes salen por CLI
 * (`npm run informe`, G-08) porque la unica ENTRADA de C4 es la cola (D-03).
 * Aqui solo se responde una pregunta: ¿este proceso sigue viendo su base?
 */
@ApiTags('observabilidad')
@Controller()
export class SaludController {
  constructor(private readonly salud: SaludService) {}

  @Get('health')
  @ApiOperation({
    summary: 'Salud del consumidor · TOCA LA BASE',
    description:
      'Consulta de verdad, no devuelve un 200 fijo. Un proceso vivo no dice nada: C4 ' +
      'puede estar corriendo con el Postgres caido y seguir sacando mensajes de la ' +
      'cola —los borraria sin persistir y P4 daria de menos, sin un solo error en los ' +
      'logs—. Por eso `ok` es LA BASE.\n\n' +
      '⚠ Contesta **200 tambien cuando la base esta caida**, con `ok:false` dentro. Un ' +
      'chequeo que solo mire el codigo HTTP deja la task en verde justo en el caso que ' +
      'este endpoint existe para detectar: mirar `ok`.\n\n' +
      'Lo otro que importa es `consumidor.corriendo`: en `false` con el proceso vivo, ' +
      'el lazo ya paro y no esta consumiendo nada.',
  })
  @ApiResponse({ status: 200, type: SaludDto, description: '`ok:false` si la base no contesta.' })
  health(): Promise<SaludDto> {
    return this.salud.salud();
  }

  @Get('status')
  @ApiOperation({
    summary: 'Contadores del lazo, sin tocar la base',
    description:
      'El lado barato: solo memoria. Sirve para mirar el ritmo durante una corrida sin ' +
      'anadirle una consulta a Postgres a cada sondeo.',
  })
  @ApiResponse({ status: 200, type: StatusDto })
  status(): StatusDto {
    return this.salud.estado();
  }
}
