import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { BdService } from './bd/bd.service';
import { OutboxRepository } from './bd/outbox.repository';
import { RelayService } from './relay/relay.service';
import { SaludDto, StatusDto } from './eventos.dto';
import { RegistroService } from './metricas/registro.service';
import { RETARDO } from './retardo';

/**
 * Lo que se puede preguntarle a C3 sin mandarle trabajo.
 *
 * Van en su propio controlador y no colgando del de eventos por una razon
 * aburrida pero real: Swagger agrupa por controlador, y con los tres endpoints
 * juntos el `POST /events` — que es el unico que importa — quedaba enterrado
 * entre dos GET de diagnostico. El orquestador hace lo mismo con su
 * StatusController.
 */
@ApiTags('observabilidad')
@Controller()
export class ObservabilidadController {
  constructor(
    private readonly registro: RegistroService,
    private readonly bd: BdService,
    private readonly outbox: OutboxRepository,
    private readonly relay: RelayService,
  ) {}

  @Get('health')
  @ApiOperation({
    summary: 'Salud del contenedor y que tramos del pipeline existen',
    description:
      'C-08: TOCA LA BASE de verdad, no devuelve un 200 fijo — un health que no ' +
      'consulta no te avisa de que un Postgres murio, y con el outbox caido C3 no ' +
      'puede entregar nada.\n\n' +
      'Lo otro que importa es `relay`: si `ocupado` se queda en `true` para siempre, el ' +
      'relay se congelo y los eventos se acumulan en silencio — el health seguiria en ' +
      'verde. Y `pausado_ms > 0` significa circuit breaker abierto: la cola no responde.',
  })
  @ApiResponse({ status: 200, type: SaludDto, description: '`ok:false` si la base no contesta.' })
  async health(): Promise<SaludDto> {
    // C-08 · la consulta de verdad. `ok` refleja la BASE, no el proceso: un
    // contenedor vivo con la base caida no puede escribir el outbox, y por
    // tanto no puede entregar nada a C4. Decir `ok:true` ahi seria mentir.
    const base = await this.bd.viva();
    return {
      ok: base,
      base,
      tenant: this.registro.tenantId,
      // Que hay hecho y que no. Un health que dice `ok` sin mas invita a creer
      // que el camino esta completo.
      tareas: { 'C-02': 'mapper', 'C-03': 'firma', 'C-04': 'cifrado', 'C-05': 'outbox', 'C-06': 'relay' },
      publica_a_sqs: true,
      outbox: base ? await this.outbox.resumen() : null,
      relay: this.relay.estado(),
      retardo_ms: RETARDO,
    };
  }

  @Get('status')
  @ApiOperation({
    summary: 'Acumulado por prueba, sin abrir archivos',
    description:
      'Lo mismo que hay en `c3/logs/<prueba>__<tenant>.json`, servido desde memoria. ' +
      'Es el lado RECIBIDO de la conciliacion: restarlo contra el `sent` del ' +
      'orquestador es lo que responde P4, porque desde un solo lado nunca puedes ' +
      'distinguir «no lo mande» de «lo mande y no llego».\n\n' +
      'Va EN VIVO: el total se reconstruye en cada llamada desde los segundos ya ' +
      'acumulados, no desde el ultimo volcado a disco. El archivo puede ir hasta un ' +
      'minuto por detras (ver el periodo de volcado); esto no.\n\n' +
      '`pasos` son los p50 en ms de cada tramo — `canonical`, `sign`, `encrypt`, ' +
      '`outbox`, `pipeline`, `delay`, `wait`, `sqs`. El detalle por segundo, con ' +
      '`init`/`completed` y p95/p99/max de cada tramo, esta en el archivo.',
  })
  @ApiResponse({ status: 200, type: StatusDto, description: 'Una entrada por prueba vista desde que arranco el proceso.' })
  status(): StatusDto {
    return this.registro.resumen();
  }
}
