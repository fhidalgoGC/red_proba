import { Injectable } from '@nestjs/common';

/**
 * O-06 — Registro de carga OFRECIDA contra carga ACEPTADA.
 *
 * ⚠ Esta es la salida principal de la prueba, no un extra de observabilidad.
 *
 * Sin este registro solo sabes lo que el sistema LOGRO. Con el sabes DONDE
 * empezo a no dar abasto, que es exactamente P3. Un sistema que acepta 1.200
 * de 1.200 y un sistema que acepta 1.200 de 2.300 producen el mismo numero de
 * eventos procesados y son dos resultados completamente distintos.
 *
 * La contabilidad separa cuatro maneras de que un evento no llegue, porque
 * cada una acusa a un culpable distinto:
 *
 *   descartados_retraso     el planificador no alcanzo a ofrecerlos.
 *                           ⚠ EL ARNES es el limite, no el sistema. Si este
 *                           numero no es ~0, la corrida no mide C3: mide el
 *                           orquestador, y hay que subirle recursos o bajar
 *                           el ritmo antes de creerle a nada.
 *
 *   descartados_saturacion  el tope de requests en vuelo del tenant estaba
 *                           lleno. El tenant no drena tan rapido como se le
 *                           ofrece. Es SEÑAL, no error.
 *
 *   rechazados              el tenant contesto, pero con un codigo != 2xx.
 *                           Rechazo explicito: 429, 503, 400…
 *
 *   fallidos                timeout o error de red. No hubo respuesta.
 *
 * Invariante: ofrecidos = descartados_retraso + descartados_saturacion +
 *                         aceptados + rechazados + fallidos + en_vuelo
 */

export interface Contadores {
  /** Lo que el reloj pidio, en EVENTOS. */
  ofrecidos: number;
  /**
   * Las mismas tres metricas, contadas en PETICIONES HTTP.
   *
   * ⚠ Sin esto no se puede responder si el limite es por peticion o por
   * evento. Con lotes de 10, un destino puede estar saturado de peticiones
   * mucho antes que de documentos —o al reves, si lo que le cuesta es firmar—
   * y desde un solo numero los dos casos son indistinguibles.
   */
  peticionesOfrecidas: number;
  peticionesEnviadas: number;
  peticionesCompletadas: number;
  peticionesAceptadas: number;
  peticionesRechazadas: number;
  peticionesFallidas: number;
  peticionesDescartadasSaturacion: number;
  peticionesDescartadasRetraso: number;
  /**
   * SENT — el instante en que se LLAMA al endpoint, no cuando acaba.
   * Es lo que gobiernan los rangos de `request`.
   */
  enviados: number;
  bytesEnviados: number;
  /**
   * COMPLETED — el endpoint RESPONDIO, con el codigo que sea.
   *
   * 200, 429, 503 y 400 cuentan todos como completado: hubo respuesta. Lo que
   * NO cuenta es `fallidos` (timeout o error de red), porque ahi no hubo
   * respuesta ninguna. `aceptados` y `rechazados` son el desglose de esto.
   */
  completados: number;
  bytesCompletados: number;
  /** Desglose de `completados`: respuesta 2xx. */
  aceptados: number;
  /** Desglose de `completados`: respuesta != 2xx. */
  rechazados: number;
  /** Sin respuesta: timeout o error de red. No son `completados`. */
  fallidos: number;
  descartadosSaturacion: number;
  descartadosRetraso: number;
  /** Bytes canonicos ofrecidos y aceptados. Con plantillas de tamaño variado,
   *  eventos/s y MB/s dejan de ser la misma metrica — y saber cual de las dos
   *  se aplana primero es lo que dice si el limite es por operacion (firma de
   *  KMS) o por byte (cifrado, red, cola). */
  bytesOfrecidos: number;
  bytesAceptados: number;
}

/**
 * Resumen de latencias de un segundo.
 *
 * Las muestras crudas se comprimen aqui EN CUANTO el segundo pasa, y el array
 * se libera. Retenerlas seria inviable: 50 tenants x 4 horas x cientos de
 * muestras por segundo son cientos de millones de numeros. El resumen ocupa
 * seis campos y da percentiles EXACTOS del segundo.
 */
export interface ResumenLatencia {
  n: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  /** Suma, para poder calcular la media al agregar. */
  suma: number;
}

interface Segundo extends Contadores {
  epoch: number;
  /** Muestras crudas. Solo vive mientras el segundo esta en curso. */
  latencias: number[];
  /** Ritmo sorteado para ese segundo, en ev/s. null en la serie global. */
  objetivo: number | null;
  /** El resumen, una vez comprimido. */
  lat?: ResumenLatencia;
}

/**
 * Techo de muestras de latencia por segundo y tenant.
 *
 * A 2.000 ev/s repartidos entre 50 tenants son ~40 muestras por segundo, muy
 * por debajo del techo: los percentiles salen exactos. Solo el tenant grande
 * de Zipf (~445 ev/s) lo roza, y ahi 250 muestras siguen dando un p99 solido.
 */
const MUESTRAS_LATENCIA = 250;

const VENTANA_SEGUNDOS = 300;

/**
 * Techo de segundos grabados por tenant. 4 horas cubre de sobra el perfil
 * completo de docs/04-orquestador.md (3 h 28 min). Al pasarlo se deja de
 * grabar el detalle por segundo y el informe lo declara.
 */
const SEGUNDOS_MAXIMOS = 14_400;

function vacio(): Contadores {
  return {
    ofrecidos: 0,
    peticionesOfrecidas: 0, peticionesEnviadas: 0, peticionesCompletadas: 0,
    peticionesAceptadas: 0, peticionesRechazadas: 0, peticionesFallidas: 0,
    peticionesDescartadasSaturacion: 0, peticionesDescartadasRetraso: 0,
    enviados: 0, bytesEnviados: 0,
    completados: 0, bytesCompletados: 0,
    aceptados: 0, rechazados: 0, fallidos: 0,
    descartadosSaturacion: 0, descartadosRetraso: 0,
    bytesOfrecidos: 0, bytesAceptados: 0,
  };
}

@Injectable()
export class MetricasService {
  private total: Contadores = vacio();
  private readonly porTenant = new Map<string, Contadores>();

  /** Anillo de un segundo por casilla. 300 casillas = 5 minutos de historia. */
  private readonly serie: (Segundo | null)[] = new Array(VENTANA_SEGUNDOS).fill(null);

  /**
   * Serie por segundo Y POR TENANT. No es anillo: el informe la necesita
   * entera. 50 tenants x 1 hora son 180.000 casillas; el techo evita que una
   * corrida de horas se coma la memoria sin avisar.
   */
  private readonly serieTenant = new Map<string, Map<number, Segundo>>();
  private readonly truncados = new Set<string>();

  private readonly codigos = new Map<number, number>();
  private readonly errores = new Map<string, number>();

  private _inicio: number | null = null;
  private _fin: number | null = null;
  private _fase = '—';
  private _ritmoObjetivo = 0;
  private _enVuelo = 0;

  // -------------------------------------------------------------------------
  // Registro
  // -------------------------------------------------------------------------

  /**
   * Borra todo y empieza de cero.
   *
   * Sin esto, la segunda corrida del mismo proceso reportaria el acumulado de
   * las dos y `POST /corridas` devolveria numeros que no son de la corrida que
   * acabas de pedir.
   */
  reiniciar(): void {
    this.total = vacio();
    this.porTenant.clear();
    this.codigos.clear();
    this.errores.clear();
    this.serie.fill(null);
    this.serieTenant.clear();
    this.truncados.clear();
    this._inicio = null;
    this._fin = null;
    this._fase = '—';
    this._ritmoObjetivo = 0;
    this._enVuelo = 0;
  }

  marcarInicio(): void { this._inicio = Date.now(); this._fin = null; }
  marcarFin(): void { this._fin = Date.now(); }
  fase(nombre: string, ritmoObjetivo: number): void {
    this._fase = nombre;
    this._ritmoObjetivo = ritmoObjetivo;
  }

  /** @param peticiones cuantas peticiones HTTP suman esos `n` eventos. */
  ofrecidos(tenantId: string, n: number, bytes = 0, peticiones = 0): void {
    this.sumar(tenantId, 'ofrecidos', n);
    this.sumar(tenantId, 'bytesOfrecidos', bytes);
    if (peticiones > 0) this.sumar(tenantId, 'peticionesOfrecidas', peticiones);
  }

  /** SENT: se llama al endpoint. Aqui, no cuando conteste. Es UNA peticion. */
  enviados(tenantId: string, n: number, bytes: number): void {
    this.sumar(tenantId, 'enviados', n);
    this.sumar(tenantId, 'bytesEnviados', bytes);
    this.sumar(tenantId, 'peticionesEnviadas', 1);
  }

  /**
   * COMPLETED: el endpoint respondio, con el codigo que sea.
   *
   * Se contabiliza `completados` SIEMPRE y ademas el desglose 2xx / no-2xx.
   * Un 429 es una respuesta: la peticion termino. Meterlo en el mismo saco que
   * un timeout borraria la diferencia entre "el destino me dijo que no" y "el
   * destino no dijo nada", que son dos diagnosticos distintos.
   */
  completados(tenantId: string, n: number, bytes: number, ms: number, codigo: number): void {
    const c = this.casilla(tenantId);
    if (c.latencias.length < MUESTRAS_LATENCIA) c.latencias.push(ms);

    this.sumar(tenantId, 'completados', n);
    this.sumar(tenantId, 'bytesCompletados', bytes);
    // Una llamada a este metodo es UNA respuesta, lleve 1 documento o 20.
    this.sumar(tenantId, 'peticionesCompletadas', 1);
    this.codigos.set(codigo, (this.codigos.get(codigo) ?? 0) + 1);

    if (codigo >= 200 && codigo < 300) {
      this.sumar(tenantId, 'aceptados', n);
      this.sumar(tenantId, 'bytesAceptados', bytes);
      this.sumar(tenantId, 'peticionesAceptadas', 1);
    } else {
      this.sumar(tenantId, 'rechazados', n);
      this.sumar(tenantId, 'peticionesRechazadas', 1);
    }
  }
  /** Una llamada = UNA peticion sin respuesta, lleve 1 documento o 20. */
  fallidos(tenantId: string, n: number, causa: string): void {
    this.sumar(tenantId, 'fallidos', n);
    this.sumar(tenantId, 'peticionesFallidas', 1);
    this.errores.set(causa, (this.errores.get(causa) ?? 0) + 1);
  }
  descartadosSaturacion(tenantId: string, n: number): void {
    this.sumar(tenantId, 'descartadosSaturacion', n);
    this.sumar(tenantId, 'peticionesDescartadasSaturacion', 1);
  }
  /** @param peticiones cuantas peticiones enteras se quedaron sin salir. */
  descartadosRetraso(tenantId: string, n: number, peticiones = 0): void {
    this.sumar(tenantId, 'descartadosRetraso', n);
    if (peticiones > 0) this.sumar(tenantId, 'peticionesDescartadasRetraso', peticiones);
  }

  enVuelo(delta: number): void { this._enVuelo += delta; }

  private sumar(tenantId: string, campo: keyof Contadores, n: number): void {
    if (n === 0) return;
    this.total[campo] += n;

    let t = this.porTenant.get(tenantId);
    if (!t) { t = vacio(); this.porTenant.set(tenantId, t); }
    t[campo] += n;

    this.casilla()[campo] += n;
    this.casilla(tenantId)[campo] += n;
  }

  /**
   * Casilla del segundo actual.
   *
   * Sin `tenantId` es la global, que vive en un anillo de 300 s — /status solo
   * mira los ultimos minutos y reciclar evita que crezca sin fin.
   *
   * Con `tenantId` es la serie POR TENANT, que NO es un anillo: el informe
   * necesita todos los segundos de la corrida, no los ultimos. Crece con la
   * duracion, por eso hay un techo — ver SEGUNDOS_MAXIMOS.
   */
  private casilla(tenantId?: string): Segundo {
    const epoch = Math.floor(Date.now() / 1000);

    if (tenantId === undefined) {
      const i = epoch % VENTANA_SEGUNDOS;
      let s = this.serie[i];
      if (!s || s.epoch !== epoch) {
        s = { epoch, latencias: [], objetivo: null, ...vacio() };
        this.serie[i] = s;
      }
      return s;
    }

    let porSegundo = this.serieTenant.get(tenantId);
    if (!porSegundo) { porSegundo = new Map(); this.serieTenant.set(tenantId, porSegundo); }

    let s = porSegundo.get(epoch);
    if (!s) {
      // Al abrir un segundo nuevo se comprime el anterior y se libera su array.
      for (const viejo of porSegundo.values()) if (viejo.epoch !== epoch) comprimir(viejo);
      if (porSegundo.size >= SEGUNDOS_MAXIMOS) {
        // Se deja de grabar el detalle por segundo, pero NO en silencio: el
        // informe lo dice. Un log truncado sin avisar se lee como completo.
        this.truncados.add(tenantId);
        return { epoch, latencias: [], objetivo: null, ...vacio() };   // desechable
      }
      s = { epoch, latencias: [], objetivo: null, ...vacio() };
      porSegundo.set(epoch, s);
    }
    return s;
  }

  /**
   * El ritmo que el planificador SORTEO para este tenant en este segundo.
   *
   * Se guarda aparte de lo realmente enviado para poder comparar los dos: es
   * la unica manera de ver si la variacion que hay en la serie viene del
   * sorteo del rango o de que el sistema no dio abasto.
   */
  objetivo(tenantId: string, evS: number): void {
    const c = this.casilla(tenantId);
    c.objetivo = evS;
  }

  /**
   * Cierra los segundos que sigan con muestras crudas.
   *
   * Se llama antes de construir el informe: el ultimo segundo de cada tenant
   * nunca llego a rodar, asi que su resumen todavia no existe.
   */
  comprimirTodo(): void {
    for (const porSegundo of this.serieTenant.values()) {
      for (const s of porSegundo.values()) comprimir(s);
    }
  }

  /** La serie por segundo de un tenant, ordenada. */
  segundosDe(tenantId: string): Segundo[] {
    return [...(this.serieTenant.get(tenantId)?.values() ?? [])].sort((a, b) => a.epoch - b.epoch);
  }

  get tenantsConSerie(): string[] { return [...this.serieTenant.keys()]; }
  get seriesTruncadas(): string[] { return [...this.truncados]; }

  // -------------------------------------------------------------------------
  // Lectura
  // -------------------------------------------------------------------------

  /**
   * Los ultimos `n` segundos, del mas viejo al mas nuevo.
   *
   * Por defecto SE SALTA el segundo en curso: esta a medio llenar y en /status
   * pareceria siempre una caida del ritmo.
   *
   * `incluirActual` lo trae igualmente, y eso es lo que necesita el registro
   * por minuto: si se lo saltara, los ultimos eventos de la corrida no
   * entrarian en ninguna linea y las lineas por minuto no sumarian el total
   * del resumen. Un log cuya aritmetica no cierra no sirve para conciliar.
   */
  ultimosSegundos(n: number, incluirActual = false): Array<Contadores & { epoch: number; p50: number | null; p95: number | null }> {
    const ahora = Math.floor(Date.now() / 1000);
    const salida: Array<Contadores & { epoch: number; p50: number | null; p95: number | null }> = [];

    for (let k = n; k >= (incluirActual ? 0 : 1); k--) {
      const epoch = ahora - k;
      const s = this.serie[((epoch % VENTANA_SEGUNDOS) + VENTANA_SEGUNDOS) % VENTANA_SEGUNDOS];
      if (s && s.epoch === epoch) {
        const { latencias, ...resto } = s;
        salida.push({ ...resto, p50: percentil(latencias, 50), p95: percentil(latencias, 95) });
      } else {
        salida.push({ epoch, ...vacio(), p50: null, p95: null });
      }
    }
    return salida;
  }

  instantanea() {
    const ventana = this.ultimosSegundos(60);
    const suma = ventana.reduce<Contadores>((acc, s) => {
      for (const k of Object.keys(acc) as (keyof Contadores)[]) acc[k] += s[k];
      return acc;
    }, vacio());

    const segs = Math.max(1, ventana.length);
    const lat = ventana.flatMap((s) => (s.p50 === null ? [] : [s.p50]));

    return {
      estado: this._inicio === null ? 'detenido' : this._fin ? 'terminado' : 'corriendo',
      fase: this._fase,
      ritmo_objetivo: this._ritmoObjetivo,
      inicio: this._inicio ? new Date(this._inicio).toISOString() : null,
      fin: this._fin ? new Date(this._fin).toISOString() : null,
      transcurrido_s: this._inicio ? Math.round(((this._fin ?? Date.now()) - this._inicio) / 1000) : 0,
      en_vuelo: this._enVuelo,

      // El numero que importa: ofrecido contra aceptado, en el ultimo minuto.
      ultimo_minuto: {
        ofrecidos_por_s: +(suma.ofrecidos / segs).toFixed(1),
        // ENVIO contra TERMINACION. Son dos cosas distintas: el envio lo
        // gobierna el reloj, la terminacion la gobierna el destino.
        enviados_por_s: +(suma.enviados / segs).toFixed(1),
        aceptados_por_s: +(suma.aceptados / segs).toFixed(1),
        deficit_por_s: +((suma.ofrecidos - suma.aceptados) / segs).toFixed(1),
        ofrecidos_mb_s: +(suma.bytesOfrecidos / segs / 1024 / 1024).toFixed(3),
        aceptados_mb_s: +(suma.bytesAceptados / segs / 1024 / 1024).toFixed(3),
        bytes_medios_por_evento: suma.aceptados === 0 ? null : Math.round(suma.bytesAceptados / suma.aceptados),
        tasa_aceptacion: suma.ofrecidos === 0 ? null : +(suma.aceptados / suma.ofrecidos).toFixed(4),
        ...suma,
        latencia_http_p50_ms: percentil(lat, 50),
      },

      acumulado: { ...this.total },
      codigos_http: Object.fromEntries(this.codigos),
      errores: Object.fromEntries(this.errores),
    };
  }

  detallePorTenant() {
    return [...this.porTenant.entries()]
      .map(([id, c]) => ({
        tenant: id,
        ...c,
        tasa_aceptacion: c.ofrecidos === 0 ? null : +(c.aceptados / c.ofrecidos).toFixed(4),
      }))
      .sort((a, b) => b.ofrecidos - a.ofrecidos);
  }
}

/** Comprime las muestras de un segundo a su resumen y libera el array. */
function comprimir(s: Segundo): void {
  if (s.latencias.length === 0) return;
  const orden = [...s.latencias].sort((a, b) => a - b);
  const q = (p: number) => +orden[Math.min(orden.length - 1, Math.ceil((p / 100) * orden.length) - 1)]!.toFixed(1);
  s.lat = {
    n: orden.length,
    p50: q(50),
    p95: q(95),
    p99: q(99),
    max: +orden[orden.length - 1]!.toFixed(1),
    suma: +orden.reduce((a, b) => a + b, 0).toFixed(1),
  };
  s.latencias = [];   // liberar: es lo que hace viable una corrida de horas
}

function percentil(valores: number[], p: number): number | null {
  if (valores.length === 0) return null;
  const orden = [...valores].sort((a, b) => a - b);
  const i = Math.min(orden.length - 1, Math.floor((p / 100) * orden.length));
  return +orden[i]!.toFixed(1);
}
