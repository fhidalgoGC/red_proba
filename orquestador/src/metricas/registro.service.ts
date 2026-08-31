import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CorridaService } from '../corrida/corrida.service';
import { ManifiestoService } from './manifiesto.service';
import { MetricasService, type ResumenLatencia } from './metricas.service';

/**
 * El informe de un batch: `orquestador/logs/<prueba>.json`.
 *
 * UN objeto JSON valido por batch, con el detalle SEGUNDO A SEGUNDO de cada
 * tenant, sus minutos agregados y sus totales.
 *
 * ────────────────────────────────────────────────────────────────────────
 * POR QUE EL DETALLE POR SEGUNDO
 *
 * Para poder ver cuanto de aleatorio fue de verdad. Los rangos de `request` y
 * las llegadas de Poisson prometen variacion; un total o un promedio por
 * minuto la esconden por completo. 40 ev/s de media puede ser un ritmo plano
 * de laboratorio o rafagas de 20 y 200 — dos pruebas muy distintas con el
 * mismo promedio.
 *
 * Por eso cada segundo lleva ademas `target_per_s`: el ritmo que el
 * planificador SORTEO para ese segundo. Comparado con `sent` dice si la
 * variacion viene del sorteo o de que el sistema no dio abasto, y esa
 * distincion ningun promedio la puede hacer.
 *
 * SENT NO ES COMPLETED
 *
 *   sent       se LLAMO al endpoint. Aqui, no cuando termine.
 *   completed  el endpoint RESPONDIO, con el codigo que sea — 200, 429, 503.
 *
 * No cuadran dentro del mismo segundo, y ese desfase es la latencia: lo que se
 * envio en el segundo 5 puede completarse en el 6. Cuando el sistema se
 * atasca, `sent` mantiene su ritmo y `completed` se hunde — y esa separacion
 * es justo lo que hay que poder ver.
 *
 * `failed` (timeout o error de red) NO es `completed`: no hubo respuesta.
 * Confundirlos borraria la diferencia entre "el destino me dijo que no" y "el
 * destino no dijo nada", que son dos diagnosticos distintos.
 * ────────────────────────────────────────────────────────────────────────
 *
 * La otra mitad de la conciliacion la escribe C3 en
 * `c3/logs/<prueba>__<tenant>.json`. Desde un solo lado nunca puedes
 * distinguir "no lo mande" de "lo mande y no llego".
 */

const TICK_MS = 1_000;

/** Cuanto se espera tras el fin del envio antes de cerrar el informe. */
const ASIENTO_MS = 2_000;

/**
 * Las cifras de una ventana, POR DENTRO. Los pesos van en bytes crudos porque
 * hay que sumarlos para agregar segundos en minutos y minutos en total.
 *
 * Lo que sale al JSON es `MetricasSalida`, con los pesos ya formateados: ver
 * `presentar()`. El numero crudo se calcula, se suma y se descarta.
 */
interface Metricas {
  sent: number;
  weight_sent: number;
  completed: number;
  weight_completed: number;

  /** Desglose de `completed`. */
  ok: number;
  not_ok: number;
  /** Sin respuesta: timeout o red. No cuentan como `completed`. */
  failed: number;
  /** El reloj los pidio pero no llegaron a salir. */
  dropped_saturation: number;
  dropped_lag: number;

  /**
   * Latencia de las respuestas COMPLETADAS en esta ventana.
   *
   * En `seconds` son EXACTOS: salen de las muestras de ese segundo.
   * En `minutes` y `total` son APROXIMADOS — se agregan ponderando los
   * percentiles de cada segundo por su numero de muestras. Un percentil de
   * percentiles no es el percentil real, y el nombre del campo lo dice para
   * que nadie lo cite como exacto.
   */
  latency_p50_ms: number | null;
  latency_p99_ms: number | null;
  latency_max_ms: number | null;
  latency_avg_ms: number | null;
  latency_samples: number;
}

/**
 * Lo que sale al JSON, agrupado por ETAPA.
 *
 * Plano, los doce campos obligaban a recordar cual pertenece a que momento:
 * `ok` es del lado de la respuesta, `dropped_lag` del lado del envio, y
 * `weight_sent` / `weight_completed` se leian como dos pesos sueltos en vez de
 * como el mismo dato en dos instantes distintos.
 *
 * Agrupado, cada numero esta al lado de los que comparten su momento — y la
 * pregunta "¿esto lo mide el reloj o lo mide el destino?" se contesta mirando
 * en que bloque cayo.
 */
export interface MetricasSalida {
  /** El lado del ENVIO: lo que salio, y lo que el reloj pidio y no salio. */
  sent: {
    count: number;
    weight: string;
    /** Se programo pero el segundo cambio antes de dispararlo. Culpa: el arnes. */
    dropped_lag: number;
    /** El tope de peticiones en vuelo estaba lleno. Solo si se puso tope. */
    dropped_saturation: number;
  };
  /** El lado de la RESPUESTA: lo que volvio, como volvio y cuanto tardo. */
  completed: {
    count: number;
    weight: string;
    /** Desglose de `count` por codigo. */
    ok: number;
    not_ok: number;
    /** Salio pero NO volvio: timeout o red. No cuenta como completado. */
    failed: number;
    latency_p50_ms: number | null;
    latency_p99_ms: number | null;
    latency_max_ms: number | null;
    latency_avg_ms: number | null;
    /** Muestras de latencia: son los completados, no los enviados. */
    samples: number;
  };
}

function presentar(m: Metricas): MetricasSalida {
  return {
    sent: {
      count: m.sent,
      weight: legible(m.weight_sent),
      dropped_lag: m.dropped_lag,
      dropped_saturation: m.dropped_saturation,
    },
    completed: {
      count: m.completed,
      weight: legible(m.weight_completed),
      ok: m.ok,
      not_ok: m.not_ok,
      failed: m.failed,
      latency_p50_ms: m.latency_p50_ms,
      latency_p99_ms: m.latency_p99_ms,
      latency_max_ms: m.latency_max_ms,
      latency_avg_ms: m.latency_avg_ms,
      samples: m.latency_samples,
    },
  };
}

interface Segundo {
  seg: number;
  at: string;
  /** El ritmo que el planificador sorteo para este segundo, en ev/s. */
  target_per_s: number | null;
  metrics: MetricasSalida;
}

interface Minuto {
  min: number;
  at: string;
  complete: boolean;
  metrics: MetricasSalida;
}

/**
 * La ficha de un tenant, en tres niveles encadenados.
 *
 *   seconds  lo MEDIDO, segundo a segundo. Es la unica fuente.
 *   minutes  suma de los segundos que caen en cada minuto.
 *   total    suma de los minutos.
 *
 * La cadena importa: si cada nivel se contara por su cuenta, los tres podrian
 * discrepar y no habria manera de saber cual miente. Asi, si `total` no cuadra
 * con `seconds`, el error esta en la agregacion y no en la medicion.
 */
interface FichaTenant {
  total: MetricasSalida;
  minutes: Minuto[];
  seconds: Segundo[];
  /** Presente solo si el batch supero el techo de segundos grabados. */
  seconds_truncated?: boolean;
}

export interface InformeCorrida {
  prueba: string;
  inicio: string | null;
  fin: string | null;
  duracion_s: number;
  cerrado_por: string;
  config: Record<string, unknown>;
  resumen: Record<string, any>;
  tenants: Record<string, FichaTenant>;
  archivo: string;
}

@Injectable()
export class RegistroService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RegistroService.name);

  private readonly dir = resolve(
    process.env.ORQ_LOGS_DIR ?? join(__dirname, '..', '..', 'logs'),
  );

  private prueba = 'sin-id';
  private archivo = '';
  private timer: NodeJS.Timeout | null = null;

  private arranque: number | null = null;
  private abierta = false;
  private terminadoEn: number | null = null;
  private ultimoInforme: InformeCorrida | null = null;
  private archivoManifiesto: string | null = null;

  constructor(
    private readonly metricas: MetricasService,
    private readonly corrida: CorridaService,
    private readonly manifiesto: ManifiestoService,
  ) {}

  onModuleInit(): void {
    mkdirSync(this.dir, { recursive: true });
    this.timer = setInterval(() => this.revisar(), TICK_MS);
    this.timer.unref();
    this.logger.log(`informes en ${this.dir}`);
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.cerrar('apagado');
  }

  // -------------------------------------------------------------------------

  /** Empieza a registrar un batch nuevo. Borra el estado del anterior. */
  comenzar(): void {
    this.prueba = this.corrida.pruebaId;
    this.archivo = join(this.dir, `${this.prueba}.json`);
    this.arranque = null;
    this.terminadoEn = null;
    this.ultimoInforme = null;
    this.archivoManifiesto = null;
    this.abierta = true;
  }

  get informe(): InformeCorrida | null { return this.ultimoInforme; }
  get carpeta(): string { return this.dir; }
  get archivoJson(): string { return this.archivo; }
  get archivoManifiestoJson(): string | null { return this.archivoManifiesto; }
  get pruebaId(): string { return this.prueba; }
  get registrando(): boolean { return this.abierta; }

  // -------------------------------------------------------------------------

  private revisar(): void {
    if (!this.abierta) return;
    const inst = this.metricas.instantanea();
    if (inst.estado === 'detenido') return;

    if (this.arranque === null && inst.inicio) this.arranque = Date.parse(inst.inicio);
    if (this.arranque === null) return;

    if (inst.estado === 'terminado') {
      // ────────────────────────────────────────────────────────────────
      // CUANDO SE CIERRA, Y POR QUE NO DE INMEDIATO
      //
      // Que el planificador pare no significa que el batch haya terminado: las
      // respuestas que estaban en vuelo siguen llegando, y cerrar ahi dejaria
      // esos `completed` fuera del informe. Se cierra cuando ya no queda nada
      // en vuelo, con un techo por si alguna respuesta no vuelve nunca.
      //
      // Antes esperaba el controlador, porque el POST se quedaba abierto hasta
      // el final. Ahora el POST devuelve 202 al momento, asi que la espera
      // vive aqui: es el unico sitio que sabe cuando el informe esta completo.
      // ────────────────────────────────────────────────────────────────
      this.terminadoEn ??= Date.now();
      const esperando = Date.now() - this.terminadoEn;
      const techo = this.corrida.perfil.envio.timeoutMs + ASIENTO_MS;

      const drenado = inst.en_vuelo === 0 && esperando >= ASIENTO_MS;
      if (drenado || esperando >= techo) {
        this.cerrar(drenado ? 'fin del batch' : 'fin del batch (quedaron respuestas sin volver)');
      }
    }
  }

  /** Cierra el batch, escribe el archivo y deja el informe listo. */
  cerrar(motivo: string): InformeCorrida | null {
    if (!this.abierta || this.arranque === null) { this.abierta = false; return this.ultimoInforme; }
    this.abierta = false;

    // El ultimo segundo de cada tenant nunca llego a rodar, asi que su resumen
    // de latencias todavia no existe. Sin esto, ese segundo saldria con
    // percentiles a null.
    this.metricas.comprimirTodo();

    const inst = this.metricas.instantanea();
    const a = inst.acumulado;
    const p = this.corrida.perfil;
    const truncados = new Set(this.metricas.seriesTruncadas);
    const base = Math.floor(this.arranque / 1000);
    const minutoActual = Math.floor(Date.now() / 60_000);

    const tenants: Record<string, FichaTenant> = {};
    const totalesInternos: Metricas[] = [];
    for (const t of this.corrida.tenants) {
      const crudos = this.metricas.segundosDe(t.id);

      const seconds: Segundo[] = crudos.map((s) => ({
        seg: s.epoch - base + 1,          // 1-based desde el arranque del batch
        at: new Date(s.epoch * 1000).toISOString(),
        target_per_s: s.objetivo,
        metrics: presentar(aMetricas(s)),
      }));

      // Los minutos se agregan DESDE los segundos: una sola fuente de verdad.
      // Contarlos por separado permitiria que las dos vistas discreparan, y no
      // habria manera de saber cual miente.
      const porMinuto = new Map<number, Metricas[]>();
      for (const s of crudos) {
        const m = Math.floor(s.epoch / 60);
        porMinuto.set(m, [...(porMinuto.get(m) ?? []), aMetricas(s)]);
      }

      const minutos: Array<{ min: number; at: string; complete: boolean; metrics: Metricas }> =
        [...porMinuto.entries()]
        .sort((x, y) => x[0] - y[0])
        .map(([m, lista], i) => ({
          min: i + 1,
          at: new Date(m * 60_000).toISOString(),
          complete: m < minutoActual,
          metrics: sumar(lista),
        }));

      const minutes: Minuto[] = minutos.map((m) => ({ ...m, metrics: presentar(m.metrics) }));

      // El total sale de los MINUTOS, no de los segundos: es el ultimo
      // eslabon de la cadena seconds -> minutes -> total. Da lo mismo que
      // sumar los segundos, y precisamente por eso sirve de comprobacion.
      const totalInterno = sumar(minutos.map((x) => x.metrics));
      totalesInternos.push(totalInterno);

      const ficha: FichaTenant = {
        total: presentar(totalInterno),
        minutes,
        seconds,
      };
      if (truncados.has(t.id)) ficha.seconds_truncated = true;
      tenants[t.id] = ficha;
    }

    const informe: InformeCorrida = {
      prueba: this.prueba,
      inicio: inst.inicio,
      fin: inst.fin ?? new Date().toISOString(),
      duracion_s: inst.transcurrido_s,
      cerrado_por: motivo,

      config: {
        modo: p.modo,
        destinos: this.corrida.tenants.map((t) => t.id),
        reparto: p.reparto,
        llegadas: p.llegadas,
        peticiones: p.peticiones,
        eventos_por_request: p.envio.eventosPorRequest,
        concurrencia_por_tenant: p.envio.concurrenciaPorTenant,
        timeout_ms: p.envio.timeoutMs,
        eventos_por_hilo: p.pool.eventosPorHilo,
        semilla: p.pool.semilla,
        tamano_bytes: p.pool.tamanoBytes,
        items_por_documento: p.pool.itemsPorDocumento,
      },

      resumen: {
        /** Lo que el reloj pidio. offered = sent + dropped_lag + dropped_saturation. */
        offered: a.ofrecidos,

        sent: {
          count: a.enviados,
          weight: legible(a.bytesEnviados),
          dropped_lag: a.descartadosRetraso,
          dropped_saturation: a.descartadosSaturacion,
          per_s: inst.transcurrido_s === 0 ? null : +(a.enviados / inst.transcurrido_s).toFixed(1),
        },

        completed: {
          count: a.completados,
          weight: legible(a.bytesCompletados),
          ok: a.aceptados,
          not_ok: a.rechazados,
          failed: a.fallidos,
          per_s: inst.transcurrido_s === 0 ? null : +(a.completados / inst.transcurrido_s).toFixed(1),
          mb_per_s: inst.transcurrido_s === 0 ? null : +(a.bytesCompletados / inst.transcurrido_s / 1024 / 1024).toFixed(3),
          weight_por_evento: a.completados === 0 ? null : legible(Math.round(a.bytesCompletados / a.completados)),
          codigos_http: inst.codigos_http,
          errores: inst.errores,
        },

        veredicto: veredicto(a, {
          conexiones: p.envio.conexionesPorDestino,
          p50ms: null,   // se rellena abajo, cuando ya hay latencias agregadas
          enviadosPorS: inst.transcurrido_s === 0 ? null : a.enviados / inst.transcurrido_s,
        }),
      },

      tenants,
      archivo: this.archivo,
    };

    // La latencia global sale de los totales por tenant, no se recalcula:
    // una sola fuente de verdad.
    const global = sumar(totalesInternos);
    Object.assign(informe.resumen.completed as object, {
      latency_p50_ms: global.latency_p50_ms,
      latency_p99_ms: global.latency_p99_ms,
      latency_max_ms: global.latency_max_ms,
      latency_avg_ms: global.latency_avg_ms,
      samples: global.latency_samples,
    });
    // El veredicto se rehace con la latencia ya conocida: sin ella no puede
    // calcular el techo del pool y solo podria insinuar el culpable.
    informe.resumen.veredicto = veredicto(a, {
      conexiones: p.envio.conexionesPorDestino,
      p50ms: global.latency_p50_ms,
      enviadosPorS: inst.transcurrido_s === 0 ? null : a.enviados / inst.transcurrido_s,
    });

    this.guardar(informe);
    this.ultimoInforme = informe;

    // ────────────────────────────────────────────────────────────────────
    // O-08 · el manifiesto se vuelca AQUI y no cuando para el planificador.
    //
    // Este metodo corre cuando ya no queda nada en vuelo (o cuando vencio el
    // techo de espera): es el unico instante en que cada evento emitido tiene
    // ya su resolucion. Volcarlo antes dejaria como `en_vuelo` respuestas que
    // si llegaron, y la conciliacion las contaria como sin_confirmar.
    // ────────────────────────────────────────────────────────────────────
    this.archivoManifiesto = this.manifiesto.volcar(this.dir, this.prueba);

    // Se libera el batch AQUI y no antes: el informe de arriba lee
    // `corrida.perfil`, y desactivar primero le haria escribir la config del
    // YAML en vez de la del batch.
    //
    // Sin esta linea, un batch lanzado en segundo plano termina solo pero
    // queda marcado como activo para siempre, y la siguiente peticion muere
    // con un 500 que no dice nada.
    this.corrida.desactivar();
    return informe;
  }

  /**
   * Escritura atomica: temporal + rename. Si fallara a media escritura, un
   * archivo truncado se llevaria el batch entero.
   */
  private guardar(informe: InformeCorrida): void {
    const temporal = this.archivo + '.tmp';
    try {
      writeFileSync(temporal, JSON.stringify(informe, null, 2) + '\n', 'utf8');
      renameSync(temporal, this.archivo);
      const segs = Object.values(informe.tenants).reduce((n, t) => n + t.seconds.length, 0);
      this.logger.log(
        `[${this.prueba}] ${Object.keys(informe.tenants).length} tenant(s) · ${segs} segundos · ` +
        `sent ${informe.resumen.sent.count} · completed ${informe.resumen.completed.count} · ${this.archivo}`,
      );
    } catch (e) {
      // Que no se pueda escribir el informe NO debe tumbar el batch.
      this.logger.error(`no se pudo escribir ${this.archivo}: ${(e as Error).message}`);
    }
  }
}

// ---------------------------------------------------------------------------

interface Crudo {
  enviados: number; bytesEnviados: number;
  completados: number; bytesCompletados: number;
  aceptados: number; rechazados: number; fallidos: number;
  descartadosSaturacion: number; descartadosRetraso: number;
  lat?: ResumenLatencia;
}

function aMetricas(s: Crudo): Metricas {
  return {
    sent: s.enviados,
    weight_sent: s.bytesEnviados,
    completed: s.completados,
    weight_completed: s.bytesCompletados,
    ok: s.aceptados,
    not_ok: s.rechazados,
    failed: s.fallidos,
    dropped_saturation: s.descartadosSaturacion,
    dropped_lag: s.descartadosRetraso,
    latency_p50_ms: s.lat?.p50 ?? null,
    latency_p99_ms: s.lat?.p99 ?? null,
    latency_max_ms: s.lat?.max ?? null,
    latency_avg_ms: s.lat ? +(s.lat.suma / s.lat.n).toFixed(1) : null,
    latency_samples: s.lat?.n ?? 0,
  };
}

function sumar(lista: Metricas[]): Metricas {
  const t: Metricas = {
    sent: 0, weight_sent: 0,
    completed: 0, weight_completed: 0,
    ok: 0, not_ok: 0, failed: 0,
    dropped_saturation: 0, dropped_lag: 0,
    latency_p50_ms: null, latency_p99_ms: null, latency_max_ms: null,
    latency_avg_ms: null, latency_samples: 0,
  };

  let sumaP50 = 0, sumaP99 = 0, sumaAvg = 0, n = 0, max: number | null = null;

  for (const m of lista) {
    t.sent += m.sent; t.weight_sent += m.weight_sent;
    t.completed += m.completed; t.weight_completed += m.weight_completed;
    t.ok += m.ok; t.not_ok += m.not_ok; t.failed += m.failed;
    t.dropped_saturation += m.dropped_saturation; t.dropped_lag += m.dropped_lag;

    // Ponderado por muestras: una ventana con 200 respuestas pesa mas que una
    // con 3. Promediar los percentiles a secas le daria el mismo voto a las dos.
    if (m.latency_samples > 0) {
      n += m.latency_samples;
      sumaP50 += (m.latency_p50_ms ?? 0) * m.latency_samples;
      sumaP99 += (m.latency_p99_ms ?? 0) * m.latency_samples;
      sumaAvg += (m.latency_avg_ms ?? 0) * m.latency_samples;
      if (m.latency_max_ms !== null) max = max === null ? m.latency_max_ms : Math.max(max, m.latency_max_ms);
    }
  }

  t.latency_samples = n;
  if (n > 0) {
    t.latency_p50_ms = +(sumaP50 / n).toFixed(1);
    t.latency_p99_ms = +(sumaP99 / n).toFixed(1);
    // La media SI es exacta al agregar; el maximo tambien. Solo los
    // percentiles son aproximados.
    t.latency_avg_ms = +(sumaAvg / n).toFixed(1);
    t.latency_max_ms = max;
  }
  return t;
}

/**
 * Bytes legibles, para leer de un vistazo.
 *
 * Va SIEMPRE junto al numero crudo, nunca en su lugar: un "200 KB" en texto no
 * se puede sumar, ni graficar, ni comparar con el conteo de C3.
 */
function legible(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * El veredicto: numeros sin conclusion obligan a leerlos dos veces.
 *
 * Cuando hay saturacion, NO se insinua el culpable: se calcula. El techo de un
 * pool HTTP es `conexiones / latencia` req/s, y si el ritmo observado coincide
 * con ese numero, el cuello fue el emisor y no el destino. Decirlo con la
 * cuenta hecha evita tres corridas subiendo el parametro equivocado.
 */
function veredicto(
  a: {
    ofrecidos: number; enviados: number; completados: number; aceptados: number;
    descartadosRetraso: number; descartadosSaturacion: number;
    rechazados: number; fallidos: number;
  },
  ctx?: { conexiones: number; p50ms: number | null; enviadosPorS: number | null },
): { ok: boolean; notas: string[] } {
  const notas: string[] = [];

  // Umbral proporcional: 16 eventos de 4.187 es ruido de frontera de segundo,
  // no un arnes que no da abasto. Marcarlo como fallo cansa al lector y le
  // enseña a ignorar el veredicto.
  const pctRetraso = a.ofrecidos === 0 ? 0 : (a.descartadosRetraso / a.ofrecidos) * 100;
  const retrasoGrave = pctRetraso >= 1;

  if (a.descartadosRetraso > 0) {
    notas.push(
      retrasoGrave
        ? `EL ARNES NO DIO ABASTO: ${a.descartadosRetraso} eventos (${pctRetraso.toFixed(1)}%) que el ` +
          `reloj pidio nunca se enviaron. Este batch no mide al receptor, mide al orquestador.`
        : `${a.descartadosRetraso} eventos (${pctRetraso.toFixed(2)}%) sin enviar por redondeo de la ` +
          `frontera del segundo. Irrelevante a este volumen.`,
    );
  }

  if (a.descartadosSaturacion > 0) {
    const techo = ctx && ctx.p50ms ? ctx.conexiones / (ctx.p50ms / 1000) : null;
    const fueElEmisor = techo !== null && ctx?.enviadosPorS != null &&
      Math.abs(ctx.enviadosPorS - techo) / techo < 0.25;

    notas.push(
      `${a.descartadosSaturacion} descartados por saturacion: no llegaron a salir al cable.` +
      (techo === null
        ? ` Revisa 'connections'.`
        : fueElEmisor
          ? ` ⚠ EL CUELLO FUE EL EMISOR, no el destino: ${ctx!.conexiones} conexiones ÷ ` +
            `${(ctx!.p50ms! / 1000).toFixed(2)}s de latencia = ${techo.toFixed(0)} req/s de techo, ` +
            `y se enviaron ${ctx!.enviadosPorS!.toFixed(0)}/s. Sube 'connections' a ` +
            `${Math.ceil((a.ofrecidos / 20) * (ctx!.p50ms! / 1000) * 1.5)} o mas para el ritmo que pediste.`
          : ` El techo del pool era ${techo.toFixed(0)} req/s (${ctx!.conexiones} conexiones ÷ ` +
            `${(ctx!.p50ms! / 1000).toFixed(2)}s) y no se alcanzo, asi que el limite estaba en el destino.`),
    );
  }
  if (a.rechazados > 0) notas.push(`${a.rechazados} completados con codigo != 2xx.`);
  if (a.fallidos > 0) notas.push(`${a.fallidos} sin respuesta (timeout o red): no cuentan como completed.`);

  if (notas.length === 0) {
    notas.push(
      `Todo lo enviado se completo: ${a.completados} de ${a.enviados}. Sin retraso del arnes, ` +
      `sin saturacion, sin errores. A este ritmo el limite no esta aqui.`,
    );
  }
  return { ok: a.fallidos === 0 && a.rechazados === 0 && !retrasoGrave, notas };
}
