import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '../config/config.service';
import { PoolService } from '../generador/pool.service';
import { PlanificadorService } from '../planificador/planificador.service';
import { MetricasService } from './metricas.service';
import { RegistroService } from './registro.service';
import { SaludOrqDto } from './salud.dto';

/**
 * O-07 — `/status` en vivo.
 *
 * Las dos series de O-06 expuestas mientras la prueba corre. Es el 80% de la
 * señal de saturacion sin necesidad de montar metricas en AWS: si
 * `deficit_por_s` empieza a crecer y no vuelve a bajar, encontraste P3.
 */
@ApiTags('observabilidad')
@Controller()
export class StatusController {
  constructor(
    private readonly metricas: MetricasService,
    private readonly planificador: PlanificadorService,
    private readonly config: ConfigService,
    private readonly pool: PoolService,
    private readonly registro: RegistroService,
  ) {}

  @ApiOperation({
    summary: 'Salud del arnes · el unico `ok` que no mira una base',
    description:
      'El orquestador no tiene Postgres, asi que su `ok` no puede significar lo mismo ' +
      'que en C3 y C4. Aqui la dependencia dura es el POOL DE PLANTILLAS: sin el, el ' +
      'contenedor arranca, contesta y no materializa un solo documento — la corrida ' +
      'daria 0 ofrecidos sin un error visible.\n\n' +
      '⚠ NO consulta a los tenants. Sondear sus `/health` desde aqui le anadiria ' +
      'trafico a la prueba y el arnes acabaria midiendose a si mismo. Para saber si ' +
      'los destinos contestan estan sus propios `/health` — o `sh start --estado`.',
  })
  @ApiResponse({ status: 200, type: SaludOrqDto, description: '`ok:false` si el pool esta vacio.' })
  @Get('health')
  health(): SaludOrqDto {
    return {
      ok: this.pool.tamano > 0,
      plantillas: this.pool.tamano,
      corriendo: this.planificador.corriendo,
      destinos: this.config.tenants.length,
    };
  }

  @ApiOperation({ summary: 'Ofrecido vs enviado vs aceptado, en vivo' })
  @Get('status')
  status() {
    return {
      ...this.metricas.instantanea(),
      ritmos_vigentes: this.planificador.ritmosVigentes(),
      config: {
        modo: this.config.perfil.modo,
        peticiones: this.config.perfil.peticiones,
        tenants: this.config.tenants.length,
        reparto: this.config.perfil.reparto,
        llegadas: this.config.perfil.llegadas,
        eventos_por_request: this.config.perfil.envio.eventosPorRequest,
        plantillas: this.pool.tamano,
        tamano_plantillas: this.pool.distribucion(),
        muestras_verificadas: this.pool.muestrasVerificadas,
        prueba: this.registro.pruebaId,
        logs: this.registro.archivoJson,
        manifiesto: this.registro.archivoManifiestoJson,
      },
    };
  }

  /** Ofrecido vs aceptado desglosado por tenant. El reparto Zipf se ve aqui. */
  @ApiOperation({ summary: 'Desglose por tenant — el reparto Zipf se ve aqui' })
  @Get('status/tenants')
  tenants() {
    return { tenants: this.metricas.detallePorTenant() };
  }

  /** La serie segundo a segundo. Es lo que se grafica para responder P2 y P3. */
  @ApiOperation({ summary: 'La serie segundo a segundo (P2 y P3)' })
  @ApiQuery({ name: 'segundos', required: false, example: 120 })
  @Get('status/serie')
  serie(@Query('segundos') segundos?: string) {
    const n = Math.min(300, Math.max(1, Number(segundos) || 120));
    return { serie: this.metricas.ultimosSegundos(n) };
  }

  /** El plan de reparto tal como lo calculo el planificador. */
  @ApiOperation({ summary: 'El reparto tal como lo calculo el planificador' })
  @Get('status/plan')
  plan() {
    return { plan: this.planificador.plan() };
  }

}
