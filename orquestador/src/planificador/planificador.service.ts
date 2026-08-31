import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { CorridaService } from '../corrida/corrida.service';
import type { Fase, Tenant } from '../config/tipos';
import { EmisorService } from '../emisor/emisor.service';
import { PoolService } from '../generador/pool.service';
import type { Documento } from '../generador/payload';
import type { DocumentoListo } from '../generador/pool.service';
import { prng } from '../generador/payload';
import { ManifiestoService } from '../metricas/manifiesto.service';
import { MetricasService } from '../metricas/metricas.service';
import { Hilos } from './hilos';
import { calcularPesos, repartirEntero } from './reparto';

/**
 * O-02 — El planificador. Dispara SEGUN EL RELOJ, no segun las respuestas.
 *
 * ⚠ Esta es la regla critica del track. Si esperara a que el tenant conteste
 * para mandar lo siguiente, un sistema lento recibiria menos carga — y
 * medirias un sistema que se ve sano porque nadie lo esta presionando. Se
 * llama omision coordinada y es la forma mas comun de que una prueba de carga
 * mienta.
 *
 * En codigo eso significa una cosa concreta: en este archivo NUNCA se hace
 * `await` de un envio. `EmisorService.enviar()` devuelve un booleano, no una
 * promesa. Si algun dia alguien le pone un await, la prueba deja de medir lo
 * que dice medir.
 *
 * Si el ritmo objetivo supera lo que el propio planificador alcanza a ofrecer,
 * la diferencia se cuenta como `descartados_retraso` — es decir, se acusa al
 * ARNES, no al sistema. Esa distincion es la que permite defender el numero.
 */

interface EstadoTenant {
  tenant: Tenant;
  peso: number;
  hilos: Hilos;
  /** El plan de la corrida, un elemento por segundo. Ver `PlanSegundo`. */
  plan: PlanSegundo[];
  /** Indice del segundo que se esta disparando ahora. -1 = ninguno. */
  activo: number;
  /** Cuantos eventos del segundo activo ya salieron. */
  disparado: number;
  buffer: Documento[];
  bufferBytes: number;
  bufferDesde: number;
  /** modo smoke: llamadas pre-programadas (offset ms desde el inicio, tamaño). */
  llamadas: Array<{ offsetMs: number; eventos: number }>;
  siguienteLlamada: number;
}

/**
 * Un evento planificado. Guarda el INDICE de la plantilla, no el documento.
 *
 * Un indice es un numero; un documento son 2 KB. Planificar por delante los
 * 25 millones de eventos de una corrida larga solo es viable si el plan pesa
 * lo que pesan 25 millones de enteros.
 */
interface EventoPlan {
  /** Instante absoluto en ms. */
  ms: number;
  plantilla: number;
  rpfId: string;
  sequence: number;
}

/** El plan de un segundo: su cuota, sus instantes y, cuando toca, sus cuerpos. */
interface PlanSegundo {
  /** 1-based desde el arranque de la corrida. */
  seg: number;
  /** Segundo absoluto (epoch en segundos). */
  epoch: number;
  cuota: number;
  eventos: EventoPlan[];
  /** Los documentos ya construidos. null mientras no se ha materializado. */
  docs: DocumentoListo[] | null;
}

/**
 * Cuantos segundos por delante se materializan los documentos.
 *
 * Materializar es construir el cuerpo: copiar la plantilla, refrescar la
 * identidad y ajustar el relleno. Hacerlo en el momento de disparar mete ese
 * trabajo en el camino critico, y a ritmos altos es lo que hace que un
 * segundo se coma tiempo del siguiente.
 *
 * Con una ventana por delante, el disparo es solo "coge el documento que ya
 * esta hecho y mandalo". Node tiene un solo hilo, asi que esto no es
 * paralelismo de verdad: es usar el tiempo muerto entre ticks, que ahora
 * mismo se desperdicia.
 *
 * 5 segundos es el compromiso: suficiente colchon para absorber un pico de
 * trabajo, poco para que la memoria no se dispare — a 3.000 ev/s son ~15.000
 * documentos vivos, unos 34 MB.
 */
const VENTANA_MATERIALIZACION = 5;

/**
 * Cuantos segundos se planifican por delante.
 *
 * El plan es barato (indices, no cuerpos) pero no infinito: una corrida de
 * 3,5 h a 2.000 ev/s son 25 millones de entradas. Se planifica por tramos y
 * se va extendiendo, en vez de construir todo al arrancar.
 */
const HORIZONTE_PLAN = 60;

@Injectable()
export class PlanificadorService implements OnApplicationShutdown {
  private readonly logger = new Logger(PlanificadorService.name);

  private estados: EstadoTenant[] = [];
  private timer: NodeJS.Timeout | null = null;
  private inicio = 0;
  private r = prng(1);
  /**
   * Flujo aparte para sortear el ritmo de cada segundo.
   *
   * Un consumidor, un flujo: si compartiera el de los intervalos de Poisson,
   * activar los rangos de `request` desplazaria TODAS las llegadas y dos
   * corridas con la misma semilla dejarian de ser comparables.
   */
  private rRitmo = prng(2);
  private faseActual = '';

  private segundoRitmo = -1;

  constructor(
    private readonly corrida: CorridaService,
    private readonly pool: PoolService,
    private readonly emisor: EmisorService,
    private readonly metricas: MetricasService,
    private readonly manifiesto: ManifiestoService,
  ) {}

  get corriendo(): boolean { return this.timer !== null; }

  // -------------------------------------------------------------------------
  // Control
  // -------------------------------------------------------------------------

  iniciar(): void {
    if (this.timer) throw new Error('la corrida ya esta en marcha');

    const perfil = this.corrida.perfil;
    const tenants = this.corrida.tenants;
    const pesos = calcularPesos(tenants, perfil.reparto);

    this.r = prng(perfil.pool.semilla ^ 0x9e3779b9);
    this.rRitmo = prng(perfil.pool.semilla ^ 0x85ebca6b);
    this.segundoRitmo = -1;
    this.inicio = Date.now();

    this.estados = tenants.map((tenant, i) => ({
      tenant,
      peso: pesos[i]!,
      hilos: new Hilos(perfil.pool.eventosPorHilo),
      plan: [],
      activo: -1,
      disparado: 0,
      buffer: [],
      bufferBytes: 0,
      bufferDesde: 0,
      llamadas: [],
      siguienteLlamada: 0,
    }));

    if (perfil.modo === 'smoke') this.programarSmoke();

    this.metricas.marcarInicio();
    // Sin esto, la segunda corrida del proceso conciliaria contra los
    // expedientes de la primera y reportaria perdidas ya explicadas.
    this.manifiesto.reiniciar();

    // El plan y la primera ventana de cuerpos se construyen ANTES de arrancar
    // el reloj. Si se hiciera con el reloj corriendo, el primer segundo
    // llevaria encima el coste de construir su propio contenido y saldria
    // corto — justo el segundo que mas se mira.
    if (perfil.modo === 'carga') {
      const t0 = Date.now();
      const ritmo = perfil.carga.fases[0]?.ritmo ?? 0;
      this.segundoRitmo = Math.floor(this.inicio / 1000);
      this.asegurarPlan(this.segundoRitmo + HORIZONTE_PLAN, ritmo);
      for (const e of this.estados) {
        for (const s of e.plan.slice(0, VENTANA_MATERIALIZACION)) this.materializar(e, s);
      }
      this.segundoRitmo = -1;   // que el primer tick active el segundo de verdad
      const planeados = this.estados.reduce((n, e) => n + e.plan.reduce((m, s) => m + s.cuota, 0), 0);
      this.logger.log(
        `plan listo: ${planeados} eventos en ${this.estados[0]?.plan.length ?? 0} segundos · ` +
        `${VENTANA_MATERIALIZACION}s de cuerpos por delante · ${Date.now() - t0} ms`,
      );
    }

    this.timer = setInterval(() => this.tick(), perfil.llegadas.tickMs);

    this.logger.log(
      `corrida iniciada · modo=${perfil.modo} · ${tenants.length} tenants · ` +
      `reparto=${perfil.reparto.tipo} · llegadas=${perfil.llegadas.tipo} · ` +
      `${perfil.envio.eventosPorRequest} evento(s) por request`,
    );
    this.logger.log(`duracion prevista: ${(this.duracionTotalMs() / 1000).toFixed(0)} s`);
  }

  detener(motivo = 'detenido a mano'): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    // Sacar lo que quedo en los buffers: si no, esos eventos figuran como
    // ofrecidos y nunca como aceptados, y el deficit final seria mentira.
    for (const e of this.estados) this.vaciarBuffer(e);
    this.metricas.marcarFin();
    this.logger.log(`corrida terminada (${motivo})`);
  }

  onApplicationShutdown(): void { this.detener('SIGTERM'); }

  // -------------------------------------------------------------------------
  // El lazo
  // -------------------------------------------------------------------------

  private tick(): void {
    const ahora = Date.now();
    const transcurrido = ahora - this.inicio;

    if (transcurrido >= this.duracionTotalMs()) {
      this.detener('perfil agotado');
      return;
    }

    if (this.corrida.perfil.modo === 'smoke') this.tickSmoke(ahora, transcurrido);
    else this.tickCarga(ahora, transcurrido);

    this.vaciarBuffersVencidos(ahora);
  }

  /** Modo carga: ritmo sostenido por fase, Poisson por tenant. */
  private tickCarga(ahora: number, transcurrido: number): void {
    const fase = this.faseEn(transcurrido);
    if (!fase) { this.detener('perfil agotado'); return; }

    if (fase.nombre !== this.faseActual) {
      this.faseActual = fase.nombre;
      this.logger.log(`fase '${fase.nombre}' · objetivo ${fase.ritmo} eventos/s`);
    }
    this.metricas.fase(fase.nombre, fase.ritmo);

    // ────────────────────────────────────────────────────────────────────
    // UN SEGUNDO, UNA CAJA CERRADA
    //
    // El plan de cada segundo se construye por delante y sus documentos se
    // materializan con una ventana de ventaja. Cuando el reloj entra en un
    // segundo, disparar es solo coger cuerpos ya hechos: ningun segundo se
    // come el tiempo del siguiente construyendo payloads.
    //
    // Y las cajas no se mezclan. Lo que quede sin disparar al cambiar de
    // segundo NO se arrastra al siguiente — se cuenta como atraso del arnes.
    // Arrastrarlo haria que un segundo pudiera superar su cuota maxima con
    // deuda del anterior, y el rango dejaria de significar nada.
    // ────────────────────────────────────────────────────────────────────
    const segAbs = Math.floor(ahora / 1000);

    if (segAbs !== this.segundoRitmo) {
      this.cerrarSegundo();
      this.segundoRitmo = segAbs;

      for (const e of this.estados) {
        const i = e.plan.findIndex((x) => x.epoch === segAbs);
        e.activo = i;
        e.disparado = 0;
        this.metricas.objetivo(e.tenant.id, i >= 0 ? e.plan[i]!.cuota : 0);
      }
    }

    for (const e of this.estados) {
      if (e.activo < 0) continue;
      const s = e.plan[e.activo];
      if (!s) continue;

      // Si la ventana de materializacion se quedo corta, se materializa aqui
      // mismo: mas vale un segundo con trabajo extra que un segundo vacio.
      if (s.docs === null) this.materializar(e, s);

      while (e.disparado < s.eventos.length && s.eventos[e.disparado]!.ms <= ahora) {
        const listo = s.docs![e.disparado]!;
        this.metricas.ofrecidos(e.tenant.id, 1, listo.bytes);

        if (e.buffer.length === 0) e.bufferDesde = ahora;
        e.buffer.push(listo.doc);
        e.bufferBytes += listo.bytes;
        if (e.buffer.length >= this.corrida.perfil.envio.eventosPorRequest) this.vaciarBuffer(e);

        e.disparado++;
      }
    }

    // Con el tiempo que sobra del tick se planifica y materializa por delante.
    // Es el trabajo que antes caia dentro del disparo.
    this.prepararPorDelante(segAbs, fase.ritmo);
  }

  /** Lo que no llego a salir del segundo que acaba se acusa al arnes. */
  private cerrarSegundo(): void {
    for (const e of this.estados) {
      if (e.activo < 0) continue;
      const s = e.plan[e.activo];
      if (s) {
        const pendientes = s.eventos.length - e.disparado;
        if (pendientes > 0) {
          this.metricas.ofrecidos(e.tenant.id, pendientes);
          this.metricas.descartadosRetraso(e.tenant.id, pendientes);
          // ⚠ O-08. Estos eventos tienen `rpf_id` y `sequence` asignados desde
          // que se planifico el segundo, pero NO salieron. Si el manifiesto no
          // los marcara, la conciliacion veria sus secuencias ausentes en C4 y
          // acusaria a C3 de perder eventos que nunca existieron.
          this.manifiesto.noEmitidos(
            e.tenant.id,
            s.eventos.slice(e.disparado).map((ev) => ({ rpf_id: ev.rpfId, sequence: ev.sequence })),
            'retraso',
          );
        }
        // El segundo ya paso: se sueltan sus cuerpos para que no se acumulen.
        s.docs = null;
      }
      e.activo = -1;
      e.disparado = 0;
    }
  }

  /**
   * Extiende el plan y materializa la ventana que viene.
   *
   * Se hace en cada tick, no una vez por segundo, para repartir el trabajo:
   * con ticks de 10 ms hay 100 oportunidades por segundo de adelantar un poco
   * en vez de una sola de adelantar mucho.
   */
  private prepararPorDelante(segAbs: number, ritmoFase: number): void {
    this.asegurarPlan(segAbs + HORIZONTE_PLAN, ritmoFase);

    for (const e of this.estados) {
      for (const s of e.plan) {
        if (s.epoch < segAbs || s.epoch > segAbs + VENTANA_MATERIALIZACION) continue;
        if (s.docs === null) { this.materializar(e, s); return; }   // uno por tick
      }
    }
  }

  /** Construye los cuerpos de un segundo a partir de los indices del plan. */
  private materializar(e: EstadoTenant, s: PlanSegundo): void {
    const docs: DocumentoListo[] = new Array(s.eventos.length);
    for (let i = 0; i < s.eventos.length; i++) {
      const ev = s.eventos[i]!;
      docs[i] = this.pool.materializar(ev.plantilla, ev.rpfId, ev.sequence);
    }
    s.docs = docs;
  }

  /**
   * Planifica hasta el segundo `hasta`: cuota, instantes e indices de plantilla.
   *
   * Aqui es donde se decide TODA la aleatoriedad de la corrida — cuantos, en
   * que instante y con que documento — antes de que salga un solo evento. El
   * plan queda inspeccionable en GET /status/plan.
   */
  private asegurarPlan(hasta: number, ritmoFase: number): void {
    const primero = this.estados[0];
    if (!primero) return;

    let siguiente = primero.plan.length === 0
      ? Math.floor(this.inicio / 1000)
      : primero.plan[primero.plan.length - 1]!.epoch + 1;

    const finCorrida = Math.floor((this.inicio + this.duracionTotalMs()) / 1000);

    while (siguiente <= Math.min(hasta, finCorrida)) {
      const cuotas = this.sortearCuotas(ritmoFase);
      const seg = siguiente - Math.floor(this.inicio / 1000) + 1;

      this.estados.forEach((e, idx) => {
        const cuota = cuotas[idx] ?? 0;
        const ms = this.instantes(cuota, siguiente * 1000);
        const eventos: EventoPlan[] = ms.map((t) => {
          const { rpfId, sequence } = e.hilos.siguiente();
          return { ms: t, plantilla: this.pool.sortearIndice(), rpfId, sequence };
        });
        e.plan.push({ seg, epoch: siguiente, cuota, eventos, docs: null });
      });

      siguiente++;
    }

    // Se tiran los segundos ya consumidos para que el plan no crezca sin fin.
    for (const e of this.estados) {
      const corte = e.plan.findIndex((x) => x.epoch >= this.segundoRitmo);
      if (corte > 0) {
        e.plan.splice(0, corte);
        if (e.activo >= 0) e.activo -= corte;
      }
    }
  }

  /**
   * Los N instantes de un segundo, en milisegundos absolutos.
   *
   *   poisson   N posiciones uniformes al azar, ordenadas. Produce racimos y
   *             huecos — es un proceso de Poisson condicionado a N llegadas.
   *   uniforme  N posiciones equiespaciadas. Trafico de laboratorio.
   */
  private instantes(n: number, inicioSeg: number): number[] {
    if (n <= 0) return [];

    // ────────────────────────────────────────────────────────────────────
    // NADA SE PROGRAMA EN EL ULTIMO TICK DEL SEGUNDO.
    //
    // El lazo corre cada `tick_ms`. Un evento programado en el milisegundo
    // 999,7 no tiene ningun tick antes de que el segundo cambie, asi que se
    // quedaba sin disparar y se contaba como atraso del arnes. A 200 ev/s eso
    // era 1-3 eventos por segundo: poco, pero era perdida sistematica y salia
    // en el informe como si el orquestador no diera abasto.
    //
    // Comprimiendo la ventana a `1000 - tick`, todo instante programado tiene
    // al menos un tick por delante. No se pierde nada y el rango se sigue
    // respetando: son los mismos N eventos, solo que repartidos en 990 ms en
    // vez de 1000.
    // ────────────────────────────────────────────────────────────────────
    const ventana = Math.max(1, 1000 - this.corrida.perfil.llegadas.tickMs);

    if (this.corrida.perfil.llegadas.tipo === 'uniforme') {
      const paso = ventana / n;
      return Array.from({ length: n }, (_, i) => inicioSeg + Math.floor(i * paso));
    }

    const pos = Array.from({ length: n }, () => this.r() * ventana).sort((a, b) => a - b);
    return pos.map((p) => inicioSeg + Math.floor(p));
  }

  /**
   * Modo smoke: un total fijo de eventos, repartido en un numero aleatorio de
   * llamadas por tenant. Cada llamada es una RAFAGA: sus eventos salen todos
   * a la vez, en requests concurrentes, sin esperar respuesta entre ellas.
   */
  private tickSmoke(ahora: number, transcurrido: number): void {
    this.metricas.fase('smoke', 0);
    let pendientes = false;

    for (const e of this.estados) {
      while (e.siguienteLlamada < e.llamadas.length) {
        const ll = e.llamadas[e.siguienteLlamada]!;
        if (ll.offsetMs > transcurrido) break;
        e.siguienteLlamada++;
        this.rafaga(e, ll.eventos, ahora);
      }
      if (e.siguienteLlamada < e.llamadas.length) pendientes = true;
    }

    if (!pendientes) this.detener('todas las llamadas disparadas');
  }

  /** Una rafaga: N eventos hacia el mismo tenant, todos en vuelo a la vez. */
  private rafaga(e: EstadoTenant, eventos: number, ahora: number): void {
    const porRequest = this.corrida.perfil.envio.eventosPorRequest;
    let restantes = eventos;

    while (restantes > 0) {
      const n = Math.min(porRequest, restantes);
      const lote: Documento[] = new Array(n);
      let bytes = 0;
      for (let i = 0; i < n; i++) {
        const { rpfId, sequence } = e.hilos.siguiente();
        const listo = this.pool.tomar(rpfId, sequence);
        lote[i] = listo.doc;
        bytes += listo.bytes;
      }
      this.metricas.ofrecidos(e.tenant.id, n, bytes);
      // Sin await: las requests de la rafaga quedan todas en vuelo a la vez.
      this.emisor.enviar(e.tenant, lote, bytes);
      restantes -= n;
    }
    void ahora;
  }

  // -------------------------------------------------------------------------
  // Emision y lotes
  // -------------------------------------------------------------------------

  private emitir(e: EstadoTenant, ahora: number): void {
    const { rpfId, sequence } = e.hilos.siguiente();
    const listo = this.pool.tomar(rpfId, sequence);

    this.metricas.ofrecidos(e.tenant.id, 1, listo.bytes);

    if (e.buffer.length === 0) e.bufferDesde = ahora;
    e.buffer.push(listo.doc);
    e.bufferBytes += listo.bytes;

    if (e.buffer.length >= this.corrida.perfil.envio.eventosPorRequest) {
      this.vaciarBuffer(e);
    }
  }

  /**
   * Saca los lotes parciales que llevan demasiado esperando.
   *
   * Sin esto, un tenant de la cola larga de Zipf (a ~9 eventos/s) tardaria
   * segundos en llenar un lote de 20 y le estarias metiendo latencia
   * artificial a la medicion — latencia del arnes disfrazada de latencia del
   * sistema.
   */
  private vaciarBuffersVencidos(ahora: number): void {
    const espera = this.corrida.perfil.envio.esperaMaximaLoteMs;
    for (const e of this.estados) {
      if (e.buffer.length > 0 && ahora - e.bufferDesde >= espera) this.vaciarBuffer(e);
    }
  }

  private vaciarBuffer(e: EstadoTenant): void {
    if (e.buffer.length === 0) return;
    const lote = e.buffer;
    const bytes = e.bufferBytes;
    e.buffer = [];
    e.bufferBytes = 0;
    e.bufferDesde = 0;
    this.emisor.enviar(e.tenant, lote, bytes);
  }

  // -------------------------------------------------------------------------
  // Perfil
  // -------------------------------------------------------------------------

  /**
   * La CUOTA de cada tenant para este segundo: un numero entero de eventos.
   *
   * Sin `request.client` se comporta como siempre: el ritmo de la fase
   * repartido por los pesos (Zipf o uniforme).
   *
   * Con `request.client`, cada tenant sortea su propio entero dentro del
   * rango y ese numero se cumple EXACTO. El reparto Zipf no interviene: el
   * rango es por cliente, asi que cada uno vale lo mismo frente a el.
   */
  private sortearCuotas(ritmoFase: number): number[] {
    const { porCliente } = this.corrida.perfil.peticiones;
    const pesos = this.estados.map((e) => e.peso);

    // Sin rango: el ritmo de la fase repartido por los pesos (Zipf o uniforme).
    if (!porCliente) return repartirEntero(Math.round(ritmoFase), pesos);

    // Con rango: cada cliente sortea su ENTERO dentro de [min, max]. Ese es el
    // numero exacto que va a salir ese segundo — ni uno mas ni uno menos.
    // Los limites vienen del POST; aqui no hay ningun valor propio.
    const { min, max } = porCliente;
    return this.estados.map(() => Math.floor(min + this.rRitmo() * (max - min + 1)));
  }

  /** Los ritmos vigentes, para /status. */
  ritmosVigentes(): Array<{ tenant: string; ev_s: number; disparados: number; materializados: number }> {
    return this.estados.map((e) => {
      const s = e.activo >= 0 ? e.plan[e.activo] : undefined;
      return {
        tenant: e.tenant.id,
        ev_s: s?.cuota ?? 0,
        disparados: e.disparado,
        materializados: e.plan.filter((x) => x.docs !== null).length,
      };
    });
  }

  private faseEn(transcurrido: number): Fase | null {
    let acumulado = 0;
    for (const f of this.corrida.perfil.carga.fases) {
      acumulado += f.duracionMs;
      if (transcurrido < acumulado) return f;
    }
    return null;
  }

  private duracionTotalMs(): number {
    const p = this.corrida.perfil;
    if (p.modo === 'smoke') {
      // Un poco de cola para que la ultima rafaga alcance a salir.
      return p.smoke.duracionObjetivoMs + p.llegadas.tickMs * 2;
    }
    return p.carga.fases.reduce((a, f) => a + f.duracionMs, 0);
  }

  /**
   * Programa las llamadas del modo smoke.
   *
   * El total de eventos se reparte entre tenants con el mismo criterio que el
   * modo carga (Zipf o uniforme), usando reparto por resto mayor para que la
   * suma de todos los tenants sea EXACTAMENTE `eventos_totales` — ese es el
   * numero contra el que se concilia P4.
   */
  private programarSmoke(): void {
    const { eventosTotales, llamadasPorTenant, duracionObjetivoMs } = this.corrida.perfil.smoke;
    const [minLl, maxLl] = llamadasPorTenant;

    const porTenant = repartirEntero(eventosTotales, this.estados.map((e) => e.peso));

    let programados = 0;
    for (let i = 0; i < this.estados.length; i++) {
      const e = this.estados[i]!;
      const eventos = porTenant[i]!;
      if (eventos === 0) continue;

      // No se pueden hacer mas llamadas que eventos: una llamada vacia no
      // ofrece nada y desbalancearia el conteo.
      const llamadas = Math.min(eventos, minLl + Math.floor(this.r() * (maxLl - minLl + 1)));
      const tamanos = repartirEntero(eventos, new Array(llamadas).fill(1 / llamadas));

      e.llamadas = tamanos
        .map((n) => ({ offsetMs: Math.floor(this.r() * duracionObjetivoMs), eventos: n }))
        .sort((a, b) => a.offsetMs - b.offsetMs);

      programados += eventos;
    }

    this.logger.log(
      `smoke programado: ${programados} eventos en ` +
      `${this.estados.reduce((a, e) => a + e.llamadas.length, 0)} llamadas ` +
      `sobre ${(duracionObjetivoMs / 1000).toFixed(0)} s`,
    );

    if (programados !== eventosTotales) {
      throw new Error(
        `el reparto programo ${programados} eventos y el perfil pide ${eventosTotales}. ` +
        `La conciliacion de P4 no cerraria.`,
      );
    }
  }

  /** Para /status: lo que el planificador cree del reparto. */
  plan(): Array<{ tenant: string; peso: number; llamadas: number; programados: number }> {
    return this.estados.map((e) => ({
      tenant: e.tenant.id,
      peso: +e.peso.toFixed(6),
      llamadas: e.llamadas.length,
      programados: e.llamadas.reduce((a, l) => a + l.eventos, 0),
    }));
  }
}
