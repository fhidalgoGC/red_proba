import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, Post } from '@nestjs/common';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EmisorService } from '../emisor/emisor.service';
import { PoolService } from '../generador/pool.service';
import { MetricasService } from '../metricas/metricas.service';
import { RegistroService } from '../metricas/registro.service';
import { PlanificadorService } from '../planificador/planificador.service';
import { ApiBody, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CorridaService } from './corrida.service';
import { LanzarBatchDto } from './batch.dto';

/**
 * `POST /batch` lanza · `GET /batch/:id` consulta.
 *
 *   curl -X POST localhost:3000/batch -H 'content-type: application/json' \
 *        -d '{"id":"xxt","client":"all","seconds":20,
 *             "request":{"client":{"min":20,"max":60}}}'
 *   → 202 { "prueba": "xxt", "estado": "procesando", ... }
 *
 *   curl localhost:3000/batch/xxt
 *   → { "estado": "procesando", "progreso": {...} }   mientras corre
 *   → { "estado": "terminado",  "resumen": {...} }    cuando acaba
 *
 * ────────────────────────────────────────────────────────────────────────
 * EL POST NO ESPERA. NUNCA.
 *
 * Devuelve 202 en cuanto la corrida arranca. Una peticion HTTP que se queda
 * abierta cinco minutos es fragil por todos lados: la corta un balanceador, la
 * corta un proxy, la corta el propio cliente — y cuando eso pasa la corrida
 * sigue viva pero te has quedado sin su informe.
 *
 * Lanzar y consultar por separado tambien es lo unico que funciona contra un
 * contenedor en Fargate detras de un ALB, que es donde esto va a vivir.
 * ────────────────────────────────────────────────────────────────────────
 */

/** El identificador acaba siendo nombre de archivo; se valida siempre. */
const ID_VALIDO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

@ApiTags('batch')
@Controller('batch')
export class BatchController {
  constructor(
    private readonly corrida: CorridaService,
    private readonly planificador: PlanificadorService,
    private readonly metricas: MetricasService,
    private readonly registro: RegistroService,
    private readonly pool: PoolService,
    private readonly emisor: EmisorService,
  ) {}

  // -------------------------------------------------------------------------

  @Post()
  @HttpCode(202)
  @ApiOperation({
    summary: 'Lanza un batch de carga',
    description:
      'Arranca la corrida y devuelve 202 AL MOMENTO. No espera a que termine: una ' +
      'peticion HTTP abierta cinco minutos la corta cualquier balanceador, y ahi te ' +
      'quedas sin informe. Consulta el progreso y el resultado en GET /batch/{id}.',
  })
  @ApiBody({
    type: LanzarBatchDto,
    examples: {
      rangos: {
        summary: 'Rango de ritmo por cliente',
        value: {
          id: 'xxt', client: 'all', seconds: 20,
          request: { client: { min: 20, max: 60 } },
        },
      },
      unCliente: {
        summary: 'Un solo cliente, ritmo plano',
        value: { id: 'uno', client: 1, seconds: 20, rate: 40 },
      },
      objetivo: {
        summary: 'El objetivo de la PoC: 2000-3000 ev/s agregados',
        value: {
          id: 'objetivo', client: 'all', seconds: 300,
          request: { client: { min: 40, max: 60 } },
        },
      },
      total: {
        summary: 'Por total de eventos en vez de por ritmo',
        value: { id: 'smoke', client: 'all', seconds: 60, events: 2500 },
      },
      grupos: {
        summary: 'Forzar el techo de 300 msg/s por MessageGroupId (D-06)',
        value: { id: 'd06', client: 1, seconds: 30, rate: 400, thread: 50 },
      },
    },
  })
  @ApiResponse({ status: 202, description: 'Lanzado. Consulta en GET /batch/{id}.' })
  @ApiResponse({ status: 400, description: 'Opciones invalidas, con el motivo concreto.' })
  @ApiResponse({ status: 409, description: 'Ese id ya esta corriendo, o ya termino y su informe existe.' })
  lanzar(@Body() cuerpo: LanzarBatchDto = {}) {
    // Preparar ANTES de tocar nada: valida las opciones y resuelve el id sin
    // mutar nada. Un 400 con el motivo claro vale mas que un batch que arranca
    // y revienta a mitad dejando estado que limpiar a mano.
    let plan;
    try {
      plan = this.corrida.preparar(cuerpo ?? {});
    } catch (e) {
      throw new BadRequestException({ error: (e as Error).message });
    }

    // ── 1. ¿Hay algo corriendo? ────────────────────────────────────────────
    // Se mira la CORRIDA y no solo el planificador: entre que el planificador
    // para y el registro cierra su ultimo minuto pasan unos segundos en los que
    // el batch sigue vivo. Arrancar otro ahi dentro mezclaria los dos.
    const activa = this.corrida.activa;
    if (this.planificador.corriendo || activa) {
      const mismo = activa?.id === plan.id;
      throw new ConflictException({
        error: mismo
          ? `el batch '${plan.id}' ya esta corriendo`
          : `ya hay otro batch en marcha: '${activa?.id ?? '?'}'`,
        prueba: activa?.id ?? null,
        estado: this.planificador.corriendo ? 'enviando' : 'cerrando el informe',
        consulta: `GET /batch/${activa?.id ?? plan.id}`,
        detalle: 'Espera a que termine, o para con POST /batch/detener.',
      });
    }

    // ── 2. ¿Ese id ya se uso? ──────────────────────────────────────────────
    // Sin esta comprobacion, repetir un id SOBRESCRIBE el informe anterior en
    // silencio. Es perdida de datos, no una molestia: la corrida vieja
    // desaparece sin que nadie se entere.
    if (existsSync(join(this.registro.carpeta, `${plan.id}.json`))) {
      throw new ConflictException({
        error: `el batch '${plan.id}' ya termino`,
        estado: 'terminado',
        consulta: `GET /batch/${plan.id}`,
        detalle: 'Su informe ya existe y no se sobrescribe. Usa otro id, o consultalo.',
      });
    }

    if (plan.reconstruirPool) this.pool.reconstruir(plan.perfil.pool);

    // Los pools HTTP se rehacen solo si cambian: cerrarlos y abrirlos en cada
    // batch tiraria las conexiones keep-alive y el primer segundo mediria
    // handshakes en vez de la arquitectura.
    const conex = plan.perfil.envio.conexionesPorDestino;
    if (conex !== this.emisor.conexiones) this.emisor.reconfigurar(conex, plan.perfil.envio.timeoutMs);

    // Metricas a cero: sin esto, el segundo batch del proceso reportaria el
    // acumulado de los dos y los numeros no serian del que pediste.
    this.metricas.reiniciar();
    this.corrida.activar(plan);
    this.registro.comenzar();
    this.planificador.iniciar();

    const p = plan.perfil;
    return {
      prueba: plan.id,
      estado: 'procesando',
      destinos: plan.tenants.map((t) => t.id),
      duracion_prevista_s: p.modo === 'smoke'
        ? Math.round(p.smoke.duracionObjetivoMs / 1000)
        : Math.round(p.carga.fases.reduce((a, f) => a + f.duracionMs, 0) / 1000),
      peticiones: p.peticiones,
      consulta: `GET /batch/${plan.id}`,
      en_vivo: 'GET /status',
    };
  }

  @Post('detener')
  @HttpCode(202)
  @ApiOperation({
    summary: 'Para el batch en marcha',
    description:
      'Corta el envio. El informe se cierra solo, cuando drena lo que quedaba en ' +
      'vuelo, y se consulta con GET /batch/{id} como cualquier otro.',
  })
  detener() {
    if (!this.planificador.corriendo && !this.corrida.activa) {
      return { corriendo: false, detalle: 'no habia ningun batch en marcha' };
    }
    const prueba = this.corrida.activa?.id ?? this.registro.pruebaId;
    this.planificador.detener('parado por POST /batch/detener');
    // No se espera al informe: el registro lo cierra solo cuando drena lo que
    // quedaba en vuelo. Se consulta con GET, igual que cualquier otro batch.
    return { prueba, estado: 'cerrando el informe', consulta: `GET /batch/${prueba}` };
  }

  // -------------------------------------------------------------------------

  /** Los batches que hay en logs/. */
  @Get()
  @ApiOperation({
    summary: 'Lista los batches',
    description: 'Los informes que hay en logs/, mas el que este en marcha.',
  })
  listar() {
    let archivos: string[] = [];
    try {
      archivos = readdirSync(this.registro.carpeta).filter((f) => f.endsWith('.json'));
    } catch {
      archivos = [];
    }

    const batches = archivos.flatMap((f) => {
      try {
        const d = JSON.parse(readFileSync(join(this.registro.carpeta, f), 'utf8'));
        return [{
          prueba: d.prueba,
          inicio: d.inicio,
          duracion_s: d.duracion_s,
          sent: d.resumen?.sent?.count,
          completed: d.resumen?.completed?.count,
          weight: d.resumen?.sent?.weight,
          ok: d.resumen?.veredicto?.ok,
        }];
      } catch {
        return [];   // un archivo ilegible no debe tumbar el listado entero
      }
    }).sort((a, b) => String(b.inicio ?? '').localeCompare(String(a.inicio ?? '')));

    const activa = this.corrida.activa?.id ?? null;
    return {
      carpeta: this.registro.carpeta,
      en_marcha: activa,
      batches: activa && !batches.some((b) => b.prueba === activa)
        ? [{ prueba: activa, estado: 'procesando' }, ...batches]
        : batches,
    };
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Metricas de un batch',
    description:
      'Si todavia corre devuelve estado "procesando" con el progreso en vivo. ' +
      'Si termino devuelve el informe completo del log: resumen, ventanas por ' +
      'minuto, desglose por tenant y veredicto.',
  })
  @ApiParam({ name: 'id', example: 'xxt', description: 'El identificador del batch.' })
  @ApiResponse({ status: 200, description: 'Progreso en vivo, o el informe completo.' })
  @ApiResponse({ status: 404, description: 'No hay ningun batch con ese id.' })
  obtener(@Param('id') id: string) {
    if (!ID_VALIDO.test(id)) {
      throw new BadRequestException({ error: `identificador invalido: '${id}'` });
    }

    // Todavia en marcha: se contesta con el progreso en vivo, no con un 404.
    // El informe del log no existe hasta que el batch cierra.
    if (this.corrida.activa?.id === id || (this.registro.registrando && this.registro.pruebaId === id)) {
      return this.progreso(id);
    }

    try {
      const informe = JSON.parse(readFileSync(join(this.registro.carpeta, `${id}.json`), 'utf8'));
      return { estado: 'terminado', ...informe };
    } catch {
      throw new NotFoundException({
        error: `no hay ningun batch con id '${id}'`,
        detalle: 'GET /batch lista los que existen.',
      });
    }
  }

  // -------------------------------------------------------------------------

  private progreso(id: string) {
    const inst = this.metricas.instantanea();
    const a = inst.acumulado;
    const corriendo = this.planificador.corriendo;

    return {
      prueba: id,
      estado: 'procesando',
      // Se distingue enviando de cerrando: al terminar el reloj todavia hay
      // respuestas llegando, y los numeros siguen subiendo unos segundos.
      fase: corriendo ? 'enviando' : 'cerrando el informe',
      inicio: inst.inicio,
      transcurrido_s: inst.transcurrido_s,
      en_vuelo: inst.en_vuelo,

      progreso: {
        offered: a.ofrecidos,
        sent: {
          count: a.enviados,
          dropped_lag: a.descartadosRetraso,
          dropped_saturation: a.descartadosSaturacion,
        },
        completed: {
          count: a.completados,
          ok: a.aceptados,
          not_ok: a.rechazados,
          failed: a.fallidos,
        },
      },

      ultimo_minuto: inst.ultimo_minuto,
      ritmos_vigentes: this.planificador.ritmosVigentes(),
      detalle: 'Vuelve a consultar en unos segundos; el informe completo aparece al cerrar.',
    };
  }
}
