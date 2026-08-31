/**
 * C-06 · El relay. Lee el outbox y publica en la cola FIFO de C4.
 *
 * Vive en el MISMO proceso que el API, no en un contenedor aparte: son un
 * `@Interval` y un handler, no dos services (D-07). Un scheduler externo
 * añadiria una pieza que desplegar, vigilar y sincronizar para no ganar nada.
 *
 * Las tres cosas que el diseño marca como NO OPCIONALES, y por que:
 *
 * 1 · EL `finally`. Sin el, una excepcion deja `ocupado` en `true` para
 *     siempre: el relay se congela, el health sigue en verde y los eventos se
 *     acumulan en silencio. Es el peor fallo posible de este archivo porque no
 *     produce ni un solo error visible.
 *
 * 2 · EL DRENADO. Sin el, el techo son 10 mensajes por tick — 20/s por
 *     contenedor con `OUTBOX_POLL_MS=500`— sin importar cuanto aguanten la
 *     base o la cola. Medirias el periodo del timer, no la arquitectura.
 *
 * 3 · LA SEPARACION DE BACKOFFS. Si el problema es de la FILA va a la base
 *     (`attempts`/`next_attempt`, sobrevive a reinicios); si es de la
 *     DEPENDENCIA va en memoria (el circuit breaker). Sin lo segundo, una
 *     caida de SQS de quince minutos manda TODAS las filas a FAILED por un
 *     problema que no era de ellas.
 */
import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression, Interval, SchedulerRegistry } from '@nestjs/schedule';
import { ConfigService } from '../config/config.service';
import { OutboxRepository, type Reclamado } from '../bd/outbox.repository';
import { MetricasService } from '../metricas/metricas.service';
import { PublicadorService, type ResultadoEnvio } from './publicador.service';

/** El nombre con el que el tick vive en el SchedulerRegistry. */
const NOMBRE_TICK = 'relay-tick';
const PERIODO_POR_DEFECTO = 500;

@Injectable()
export class RelayService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('relay');

  /** Guardia: un solo tick trabajando a la vez. */
  private ocupado = false;
  /** C-07: al recibir SIGTERM se deja de tomar trabajo nuevo. */
  private parando = false;

  // ── circuit breaker · EN MEMORIA, este si ──
  //
  // Protege de la DEPENDENCIA, no de la fila. Si SQS esta caido, no tiene
  // sentido que cada tick reclame diez filas nuevas y les gaste un intento:
  // en quince minutos habrian agotado los diez y estarian todas en FAILED por
  // algo que no era suyo.
  private pausaHasta = 0;
  private fallosSeguidos = 0;

  readonly contadores = { ticks: 0, vueltas: 0, publicados: 0, pausas: 0, purgas: 0 };

  constructor(
    private readonly config: ConfigService,
    private readonly outbox: OutboxRepository,
    private readonly publicador: PublicadorService,
    private readonly scheduler: SchedulerRegistry,
    private readonly metricas: MetricasService,
  ) {}

  /**
   * Reprograma el tick con el periodo de la config.
   *
   * El decorador `@Interval` se evalua cuando se carga la clase, antes de que
   * exista la config, asi que no puede leer `OUTBOX_POLL_MS`. Se registra con
   * el default y aqui se sustituye. La alternativa —un `setInterval` a mano—
   * dejaria el timer fuera del SchedulerRegistry y `onApplicationShutdown` no
   * lo pararia: el proceso no terminaria nunca.
   */
  onModuleInit(): void {
    if (this.config.pollMs === PERIODO_POR_DEFECTO) return;
    try {
      this.scheduler.deleteInterval(NOMBRE_TICK);
      const t = setInterval(() => void this.tick(), this.config.pollMs);
      this.scheduler.addInterval(NOMBRE_TICK, t);
      this.logger.log(`tick cada ${this.config.pollMs} ms · lote ${this.config.loteRelay}`);
    } catch (e) {
      this.logger.warn(`no se pudo reprogramar el tick, sigue a ${PERIODO_POR_DEFECTO} ms: ${msj(e)}`);
    }
  }

  onApplicationShutdown(): void {
    // C-07 · Fargate da 30 segundos. Se deja de tomar trabajo nuevo; el tick
    // en vuelo termina solo, y lo que no llegue a publicarse se queda PENDING
    // con su `next_attempt` — otro contenedor, o este al reiniciar, lo toma.
    // Nada se pierde porque nada se borro del outbox.
    this.parando = true;
    this.logger.log('cierre ordenado · no se toma trabajo nuevo');
  }

  /**
   * El tick. El periodo real lo pone `onModuleInit` desde `OUTBOX_POLL_MS`.
   *
   * El guardia `ocupado` hace que un periodo mas corto de lo que tarda un
   * ciclo no acumule trabajo: los ticks que caen encima de uno en curso
   * simplemente se van.
   */
  @Interval(NOMBRE_TICK, PERIODO_POR_DEFECTO)
  async tick(): Promise<void> {
    if (this.ocupado || this.parando) return;
    if (Date.now() < this.pausaHasta) return;

    this.ocupado = true;
    this.contadores.ticks += 1;
    try {
      // DRENADO: se sigue mientras haya filas. Sin esto el techo lo pone el
      // timer, no el sistema.
      let n: number;
      do {
        n = await this.publicarLote();
        this.contadores.vueltas += 1;
      } while (n > 0 && !this.parando && Date.now() >= this.pausaHasta);
    } catch (e) {
      this.logger.error(`fallo en el relay: ${msj(e)}`);
    } finally {
      // ⚠ NO ES OPCIONAL. Ver la cabecera.
      this.ocupado = false;
    }
  }

  /** @returns cuantas filas se reclamaron. 0 = no queda nada pendiente. */
  private async publicarLote(): Promise<number> {
    const filas = await this.outbox.reclamar(this.config.loteRelay, this.config.backoffCapSeg);
    if (filas.length === 0) return 0;

    // El reclamo YA hizo commit. A partir de aqui, pase lo que pase, las filas
    // tienen attempts+1 y next_attempt futuro: si el proceso muere ahora, se
    // reintentan solas. No hace falta compensacion.
    const r = await this.publicador.publicar(filas);

    // C-09 · los dos tramos que solo el relay puede ver. Se anotan ANTES de
    // marcar las filas: si el UPDATE de `marcarEnviadas` falla, el tiempo que
    // la cola tardo en aceptar ya se midio y no se pierde.
    this.anotarMetricas(filas, r);

    if (r.ok.length > 0) {
      await this.outbox.marcarEnviadas(r.ok, r.e6);
      this.contadores.publicados += r.ok.length;
    }
    if (r.permanentes.length > 0) {
      await this.outbox.marcarFallidas(
        r.permanentes.map((x) => x.id),
        r.permanentes[0]!.codigo,
        r.permanentes[0]!.detalle,
      );
    }
    if (r.reintentar.length > 0) {
      await this.outbox.marcarFallo(
        r.reintentar.map((x) => x.id),
        r.reintentar[0]!.codigo,
        r.reintentar[0]!.detalle,
      );
    }

    this.actualizarBreaker(r.ok.length, filas.length);
    return filas.length;
  }

  /**
   * Reparte los tiempos del lote entre las pruebas que hay dentro.
   *
   * ⚠ `wait` ES POR FILA y `sqs` ES POR LOTE, y esa asimetria es real: cada
   * fila espero lo suyo en el outbox, pero la publicacion fue UNA llamada. Por
   * eso el tramo de la cola se anota una vez por prueba presente en el lote y
   * no una vez por mensaje — repetirlo diez veces daria un `n` de diez para una
   * sola medicion y un p99 falsamente estable.
   *
   * En una corrida normal todas las filas de un lote son de la misma prueba
   * (hay una corrida a la vez), asi que el reparto es exacto. El bucle existe
   * para el caso de dos batches solapados, donde lo peor que pasa es que la
   * misma llamada cuente en las dos pruebas.
   */
  private anotarMetricas(filas: Reclamado[], r: ResultadoEnvio): void {
    const ok = new Set(r.ok);
    const reintentar = new Set(r.reintentar.map((x) => x.id));
    const pruebas = new Set<string | null>();

    for (const f of filas) {
      pruebas.add(f.prueba);
      // Lo que la fila espero entre el commit y el reclamo. Es el tramo que
      // delata un relay que no da abasto: si `wait` crece mientras `sqs` se
      // mantiene, el cuello es el periodo del tick o el tamaño del lote, no la
      // cola. Las dos marcas son ISO, asi que la resta va en ms enteros — para
      // una espera de cientos de ms sobra.
      //
      // ⚠ SOLO EL PRIMER INTENTO. En un reintento, e5 se vuelve a escribir y
      // la diferencia contra e4 incluye el backoff, que es una espera QUERIDA:
      // una fila que fallo tres veces mostraria 30 segundos de "espera en el
      // outbox" y pareceria un relay atascado cuando el problema es la cola.
      // Eso ya se ve en `sqs.retry` y en `attempts`.
      if (f.e4 !== null && f.attempts === 1) {
        const espera = Date.parse(f.e5) - Date.parse(f.e4);
        if (espera >= 0) this.metricas.paso(f.prueba ?? undefined, 'wait', espera);
      }
    }

    for (const prueba of pruebas) {
      const suyas = filas.filter((f) => f.prueba === prueba);
      const nOk = suyas.filter((f) => ok.has(f.id)).length;
      const nReintento = suyas.filter((f) => reintentar.has(f.id)).length;
      // `failed` es lo que se fue a FAILED sin gastar intentos: un error
      // permanente. Sumarlo con los que se van a reintentar borraria la
      // diferencia entre «la cola dijo que no y no va a cambiar» y «la red se
      // cayo un momento», que son dos diagnosticos opuestos.
      this.metricas.publicacion(prueba ?? undefined, r.ms, {
        mensajes: suyas.length,
        ok: nOk,
        reintento: nReintento,
        fallidos: suyas.length - nOk - nReintento,
      });
    }
  }

  /**
   * El breaker se abre cuando falla el LOTE COMPLETO, no cuando falla una
   * fila. Una fila mala es problema de la fila y ya tiene su backoff en la
   * base; que no pase ni una es sintoma de que la dependencia esta caida.
   */
  private actualizarBreaker(ok: number, total: number): void {
    if (ok > 0) {
      this.fallosSeguidos = 0;
      this.pausaHasta = 0;
      return;
    }
    if (total === 0) return;

    this.fallosSeguidos += 1;
    const espera = Math.min(2 ** this.fallosSeguidos * 250, 30_000);
    this.pausaHasta = Date.now() + espera;
    this.contadores.pausas += 1;
    this.logger.warn(
      `circuit breaker · ${this.fallosSeguidos} lote(s) seguidos sin publicar nada · pausa ${espera} ms`,
    );
  }

  /**
   * Purgado. Cron de verdad, cada hora.
   *
   * ⚠ NO va en el mismo bucle que publica: borrar mientras publicas mete
   * contencion de vacuum justo bajo carga, que es cuando menos conviene.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async purgar(): Promise<void> {
    if (this.parando) return;
    try {
      const r = await this.outbox.purgar(this.config.maxIntentos);
      this.contadores.purgas += 1;
      if (r.borradas > 0 || r.fallidas > 0) {
        this.logger.log(`purga · ${r.borradas} enviadas borradas · ${r.fallidas} agotadas a FAILED`);
      }
    } catch (e) {
      this.logger.error(`fallo la purga: ${msj(e)}`);
    }
  }

  /** Para `GET /health`. */
  estado(): Record<string, unknown> {
    return {
      ...this.contadores,
      ocupado: this.ocupado,
      parando: this.parando,
      pausado_ms: Math.max(0, this.pausaHasta - Date.now()),
      fallos_seguidos: this.fallosSeguidos,
    };
  }
}

const msj = (e: unknown): string => (e instanceof Error ? e.message : String(e));
