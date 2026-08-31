/**
 * El informe de C3: `c3/logs/<prueba>__<tenant>.json`.
 *
 * UN objeto JSON valido por prueba y tenant, con el detalle SEGUNDO A SEGUNDO,
 * los minutos agregados y el total. Se abre en cualquier editor, `jq .` lo
 * formatea entero y no hace falta parser propio.
 *
 * ────────────────────────────────────────────────────────────────────────
 * POR QUE `<prueba>__<tenant>` Y NO SOLO `<prueba>`
 *
 * El orquestador escribe `<prueba>.json` porque hay UNO. De C3 hay 50, y en
 * local los dos o tres que se levantan comparten la carpeta: sin el sufijo del
 * tenant, el ultimo en cerrar pisaria a los demas y la conciliacion de P4
 * quedaria mirando el log de un tenant creyendo que es el de todos.
 *
 * La prueba llega en la cabecera `x-prueba-id` y NO dentro del documento: el
 * payload va firmado, y meterle metadatos de la corrida cambiaria lo que se
 * firma (regla 8).
 * ────────────────────────────────────────────────────────────────────────
 *
 * CUANDO SE ESCRIBE. Dos momentos, y ninguno es "al terminar la corrida":
 *
 *   1. cada FLUSH_MS mientras llega trafico   -> cerrado_por: "en curso"
 *   2. cuando la prueba lleva SILENCIO_MS callada, o llega SIGTERM
 *
 * El volcado periodico existe porque C3 no sabe cuando acaba la corrida — eso
 * lo sabe el orquestador. Sin el, un contenedor que muere a mitad de prueba se
 * llevaria el log entero, que es justo el caso en el que mas falta hace.
 *
 * ⚠ EL VOLCADO NO ES GRATIS: reescribe el archivo completo. Por eso el periodo
 * se estira cuando la serie crece (ver FLUSH_MS): un `JSON.stringify` de 10 MB
 * cada 10 segundos metería pausas de GC justo dentro de lo que se esta
 * midiendo.
 */
import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MetricasService, PASOS, type Paso, type Segundo } from './metricas.service';
import { agregar, legible, presentarPaso, type PasoSalida, type Resumen } from './muestras';

const TICK_MS = 1_000;

/** Silencio tras el que se considera terminada una prueba. */
const SILENCIO_MS = 8_000;

/**
 * Cada cuanto se reescribe el archivo de una prueba viva.
 *
 * Se estira a un minuto cuando la serie pasa de 600 segundos: a partir de ahi
 * el archivo pesa megas y reescribirlo cada 10 s competiría por CPU con el
 * pipeline que se esta midiendo.
 */
const FLUSH_MS = 10_000;
const FLUSH_MS_LARGO = 60_000;
const SEGUNDOS_PARA_FLUSH_LARGO = 600;

// ---------------------------------------------------------------------------
// La forma del JSON
// ---------------------------------------------------------------------------

/**
 * Las cifras de una ventana, agrupadas por NIVEL.
 *
 * Planas, los treinta campos obligaban a recordar cual pertenece a que
 * momento. Agrupado, cada numero esta al lado de los que comparten su nivel, y
 * la pregunta "¿esto lo mide la peticion o el documento?" se contesta mirando
 * en que bloque cayo.
 */
export interface MetricasSalida {
  /**
   * Nivel PETICION HTTP.
   *
   * Aqui vive la latencia: una respuesta es UNA peticion, lleve un documento o
   * veinte. Medir latencia "por evento" no significa nada — no hay una
   * respuesta por documento.
   */
  request: {
    /** Llego a C3. Se cuenta al LLEGAR. */
    init: number;
    /** C3 contesto 202. Se cuenta al RESPONDER: no es el mismo segundo. */
    completed: number;
    /** Reventó: no hubo 202. No cuenta como completed. */
    failed: number;
    latency_p50_ms: number | null;
    latency_p99_ms: number | null;
    latency_max_ms: number | null;
    latency_avg_ms: number | null;
    /** Muestras detras de los percentiles. Menor que `completed` = techo. */
    samples?: number;
  };

  /**
   * Nivel EVENTO — los documentos que iban dentro de esas peticiones.
   *
   * Aqui viven los bytes: el peso es de los documentos, sin el envoltorio del
   * lote, para que el numero sea comparable con el `weight` del orquestador.
   */
  events: {
    /** Documentos que llegaron dentro de esas peticiones. */
    init: number;
    /** Documentos aceptados. `init - completed - discarded` = los que reventaron. */
    completed: number;
    /** Documento invalido: no se firma ni se cifra. No es un fallo de C3. */
    discarded: number;
    bytes: number;
    weight: string;
    per_request: number | null;
    /** Contra TODA la prueba, no solo contra este segundo (regla 11). */
    event_ids_unicos: number;
    event_ids_duplicados: number;

    /**
     * Los tramos, en ms. Un paso que ni empezo NO aparece.
     *
     * Van DENTRO de `events` porque es el nivel al que se miden: los tres
     * primeros son por documento. `outbox`, `pipeline` y `delay` son por
     * peticion y `sqs` por lote — sus `init`/`completed` cuentan eso, y por
     * eso cada paso lleva su propio par en vez de heredar el de arriba.
     *
     * `init` cae en el segundo en que el tramo EMPEZO y `completed` en el que
     * TERMINO. Que en una fila no coincidan es lo normal y es el dato: 45
     * firmas iniciadas y 0 terminadas dice que KMS tiene 45 en vuelo.
     *
     * Omitir pesa menos que rellenar de ceros: en una corrida de 3.000
     * segundos, ocho pasos vacios por segundo son 24.000 lineas que dicen
     * "aqui no paso nada". Y su ausencia informa: sin `sqs` en un segundo, el
     * relay no publico en ese segundo.
     *
     * ⚠ LA ARITMETICA CUADRA EN EL `total`, NO EN UNA FILA SUELTA:
     *
     *   canonical.suma_ms + sign.suma_ms + encrypt.suma_ms + outbox.suma_ms
     *     = pipeline.suma_ms
     *   pipeline.suma_ms + delay.suma_ms  ≈  latencia total
     *
     * En una fila no tiene por que: los tramos de una peticion que cruza la
     * frontera del segundo caen repartidos entre dos filas — que es justamente
     * lo que `init` vs `completed` esta enseñando. En el total cada ejecucion
     * se cuenta una vez y la igualdad se cumple; medido sobre trafico real, el
     * residuo es del 0,0002% (~11 µs por documento: los `toISOString` de las
     * marcas y el `JSON.stringify` del sobre para pesarlo).
     *
     * `wait` y `sqs` quedan fuera de esa suma: son del relay, corren despues
     * del 202 y no pertenecen a ninguna peticion.
     */
    steps: Partial<Record<Paso, PasoSalida>>;
  };

  /** Lo que el relay le mando a la cola. `batches` son llamadas, no mensajes. */
  sqs: {
    batches: number;
    messages: number;
    ok: number;
    retry: number;
    failed: number;
  };
}

interface SegundoSalida {
  /** 1-based desde el primer segundo con actividad de la prueba. */
  seg: number;
  at: string;
  metrics: MetricasSalida;
}

interface MinutoSalida {
  min: number;
  at: string;
  complete: boolean;
  metrics: MetricasSalida;
}

export interface Informe {
  prueba: string;
  tenant: string;
  actualizado: string;
  inicio: string | null;
  fin: string | null;
  duracion_s: number;
  cerrado_por: string;
  /** Solo si la prueba supero el techo de segundos grabados. */
  seconds_truncated?: true;
  total: MetricasSalida;
  seconds: SegundoSalida[];
  /** Solo con mas de 60 segundos: agrupar 20 daria una fila igual al total. */
  minutes?: MinutoSalida[];
  archivo: string;
}

// ---------------------------------------------------------------------------

@Injectable()
export class RegistroService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('registro');

  private readonly dir = resolve(process.env.C3_LOGS_DIR ?? join(__dirname, '..', '..', 'logs'));
  private readonly tenant =
    process.env.TENANT_ID?.trim() || `puerto-${process.env.C3_PORT ?? process.env.PORT ?? '3001'}`;

  /** Ultimo volcado por prueba, para no reescribir en cada tick. */
  private readonly volcado = new Map<string, number>();
  /** Pruebas ya cerradas. Si vuelve trafico se reabren. */
  private readonly cerradas = new Set<string>();
  /** El ultimo informe de cada prueba, para `GET /status`. */
  private readonly informes = new Map<string, Informe>();

  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly metricas: MetricasService) {}

  onModuleInit(): void {
    mkdirSync(this.dir, { recursive: true });
    this.timer = setInterval(() => this.revisar(), TICK_MS);
    this.timer.unref();   // que un timer no impida cerrar el proceso
    this.logger.log(`informes por segundo en ${this.dir}`);
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    // Cerrar lo que quede abierto: sin esto se pierde el tramo final de cada
    // prueba, justo cuando mas interesa.
    for (const p of this.metricas.pruebas) {
      if (!this.cerradas.has(p)) this.cerrar(p, 'apagado');
    }
  }

  // -------------------------------------------------------------------------

  private revisar(): void {
    const t = Date.now();
    for (const prueba of this.metricas.pruebas) {
      const silencio = this.metricas.silencioDe(prueba);

      if (this.cerradas.has(prueba)) {
        // Volvio trafico despues del cierre: la prueba sigue viva y el archivo
        // tiene que volver a moverse. Pasa cuando el orquestador arranca un
        // segundo batch con el mismo id.
        if (silencio < SILENCIO_MS) this.cerradas.delete(prueba);
        continue;
      }

      if (silencio >= SILENCIO_MS) { this.cerrar(prueba, 'silencio'); continue; }

      const ultimo = this.volcado.get(prueba) ?? 0;
      const segundos = this.metricas.segundosDe(prueba).length;
      const periodo = segundos > SEGUNDOS_PARA_FLUSH_LARGO ? FLUSH_MS_LARGO : FLUSH_MS;
      if (t - ultimo >= periodo) this.volcar(prueba, 'en curso');
    }
  }

  private cerrar(prueba: string, motivo: 'silencio' | 'apagado'): void {
    this.cerradas.add(prueba);
    const informe = this.volcar(prueba, motivo);
    if (!informe) return;
    const t = informe.total;
    this.logger.log(
      `[${prueba}] cerrado por ${motivo} · ${informe.seconds.length} s · ` +
      `${t.request.init} peticiones · ${t.events.init} eventos · ` +
      `${t.events.weight} · p50 ${t.request.latency_p50_ms ?? '-'} ms` +
      (t.events.event_ids_duplicados > 0
        ? `  ⚠ ${t.events.event_ids_duplicados} event_id DUPLICADOS`
        : ''),
    );
  }

  /** Construye el informe y lo escribe. Devuelve null si no se pudo escribir. */
  private volcar(prueba: string, motivo: string): Informe | null {
    // El ultimo segundo nunca llego a rodar: sin esto saldria sin percentiles.
    this.metricas.comprimirTodo();

    const crudos = this.metricas.segundosDe(prueba).map(aBruto);
    if (crudos.length === 0) return null;

    const bordes = this.metricas.bordesDe(prueba);
    const base = crudos[0]!.epoch;
    const ahoraSeg = Math.floor(Date.now() / 1000);

    const seconds: SegundoSalida[] = crudos.map((b) => ({
      seg: b.epoch - base + 1,
      at: new Date(b.epoch * 1000).toISOString(),
      metrics: presentar(b),
    }));

    // Cada nivel se agrega DESDE EL ANTERIOR: una sola fuente de verdad. Si
    // `total` no cuadra con `seconds`, el error esta en la agregacion y no en
    // la medicion. Y `minutes` solo existe si hay mas de 60 segundos: agrupar
    // 20 en un unico "minuto" da una fila identica al total, que hay que leer
    // entera para descubrir que no aporta nada.
    const hayMinutos = crudos.length > 60;
    const cubos = hayMinutos ? agrupar(crudos, 60) : [];

    const minutes: MinutoSalida[] = cubos.map((c, i) => ({
      min: i + 1,
      at: new Date(c.clave * 60 * 1000).toISOString(),
      complete: (c.clave + 1) * 60 <= ahoraSeg,
      metrics: presentar(c.bruto, true),
    }));

    const total = hayMinutos
      ? presentar(sumar(cubos.map((c) => c.bruto)), true)
      : presentar(sumar(crudos), crudos.length > 1);

    const informe: Informe = {
      prueba,
      tenant: this.tenant,
      actualizado: new Date().toISOString(),
      inicio: bordes ? new Date(bordes.primera).toISOString() : null,
      fin: bordes ? new Date(bordes.ultima).toISOString() : null,
      duracion_s: bordes ? +((bordes.ultima - bordes.primera) / 1000).toFixed(1) : 0,
      cerrado_por: motivo,
      ...(this.metricas.truncada(prueba) ? { seconds_truncated: true as const } : {}),
      total,
      seconds,
      ...(hayMinutos ? { minutes } : {}),
      archivo: this.ruta(prueba),
    };

    this.informes.set(prueba, informe);
    this.volcado.set(prueba, Date.now());
    return this.guardar(prueba, informe) ? informe : null;
  }

  // -------------------------------------------------------------------------
  // Archivo
  // -------------------------------------------------------------------------

  /**
   * `<prueba>__<tenant>.json`, para una prueba cualquiera y no solo la viva.
   *
   * Publica porque `GET /logs/:id` la necesita: el nombre lo decide quien
   * escribe el archivo, asi que el que lo sirve pregunta en vez de volver a
   * construirlo — dos sitios armando la misma ruta es un 404 esperando a que
   * uno de los dos cambie el sufijo.
   */
  ruta(prueba: string): string {
    return join(this.dir, `${prueba}__${sanear(this.tenant)}.json`);
  }

  /**
   * Escritura atomica: temporal + rename.
   *
   * Se reescribe el archivo entero en cada volcado, asi que un fallo a media
   * escritura dejaria el JSON truncado y perderias la prueba completa, no solo
   * el ultimo tramo. Con rename, o esta el archivo viejo o el nuevo.
   */
  private guardar(prueba: string, informe: Informe): boolean {
    const destino = this.ruta(prueba);
    const temporal = destino + '.tmp';
    try {
      writeFileSync(temporal, JSON.stringify(informe, null, 2) + '\n', 'utf8');
      renameSync(temporal, destino);
      return true;
    } catch (e) {
      // Que no se pueda escribir el log NO debe tumbar al receptor: perderias
      // la corrida entera por un problema de disco.
      this.logger.error(`no se pudo escribir ${destino}: ${(e as Error).message}`);
      return false;
    }
  }

  // -------------------------------------------------------------------------

  get carpeta(): string { return this.dir; }
  get tenantId(): string { return this.tenant; }

  /** `GET /status`: lo mismo que hay en los archivos, servido desde memoria. */
  resumen() {
    // Se reconstruye en vez de devolver el ultimo volcado: entre dos volcados
    // pueden haber pasado 60 segundos, y un /status que va un minuto por
    // detras invita a creer que no esta llegando nada.
    //
    // Tambien para las cerradas: si vuelve trafico con el mismo id, el tick de
    // `revisar` las reabre hasta un segundo despues, y hasta entonces /status
    // estaria contestando con el total de antes.
    for (const p of this.metricas.pruebas) {
      const vivo = this.soloTotal(p);
      if (vivo) this.informes.set(p, vivo);
    }

    return {
      tenant: this.tenant,
      logs: this.dir,
      pruebas: [...this.informes.values()].map((i) => ({
        prueba: i.prueba,
        peticiones: i.total.request.init,
        completadas: i.total.request.completed,
        fallidas: i.total.request.failed,
        eventos: i.total.events.init,
        aceptados: i.total.events.completed,
        descartados: i.total.events.discarded,
        bytes: i.total.events.bytes,
        bytes_medios_por_evento:
          i.total.events.init === 0
            ? null
            : Math.round(i.total.events.bytes / i.total.events.init),
        event_ids_unicos: i.total.events.event_ids_unicos,
        event_ids_duplicados: i.total.events.event_ids_duplicados,
        // De la serie viva, no de `i.seconds`: el total de /status se
        // reconstruye sin armar la serie entera (armarla en cada llamada
        // costaria tanto como volcar el archivo).
        segundos: this.metricas.segundosDe(i.prueba).length,
        latency_p50_ms: i.total.request.latency_p50_ms,
        latency_p99_ms: i.total.request.latency_p99_ms,
        pasos: Object.fromEntries(
          Object.entries(i.total.events.steps).map(([k, v]) => [k, v?.p50_ms ?? null]),
        ),
        cerrada: this.cerradas.has(i.prueba),
        archivo: i.archivo,
      })),
    };
  }

  /** El total de una prueba sin construir la serie entera. Para /status. */
  private soloTotal(prueba: string): Informe | null {
    this.metricas.comprimirTodo();
    const crudos = this.metricas.segundosDe(prueba).map(aBruto);
    if (crudos.length === 0) return null;
    const bordes = this.metricas.bordesDe(prueba);
    return {
      prueba,
      tenant: this.tenant,
      actualizado: new Date().toISOString(),
      inicio: bordes ? new Date(bordes.primera).toISOString() : null,
      fin: bordes ? new Date(bordes.ultima).toISOString() : null,
      duracion_s: bordes ? +((bordes.ultima - bordes.primera) / 1000).toFixed(1) : 0,
      cerrado_por: 'en curso',
      total: presentar(sumar(crudos), crudos.length > 1),
      seconds: [],
      archivo: this.ruta(prueba),
    };
  }
}

// ---------------------------------------------------------------------------
// Agregacion
// ---------------------------------------------------------------------------

/**
 * Un segundo ya comprimido: contadores y resumenes, sin muestras crudas.
 *
 * Se separa de `Segundo` para que la agregacion sea aritmetica pura — sumar
 * `Serie`s obligaria a saber si estan comprimidas o no.
 */
interface Bruto {
  epoch: number;
  reqIniciadas: number; reqCompletadas: number; reqFallidas: number;
  evIniciados: number; evCompletados: number; evDescartados: number;
  bytes: number; idsUnicos: number; idsDuplicados: number;
  sqsLotes: number; sqsMensajes: number; sqsOk: number; sqsReintento: number; sqsFallidos: number;
  latencia?: Resumen;
  pasos: Map<Paso, Resumen>;
  /** Ejecuciones por paso: empezadas y terminadas. Van aparte del `Resumen`
   *  porque un paso que revento no deja muestra, pero si deja un `init`. */
  pasosInit: Map<Paso, number>;
  pasosFin: Map<Paso, number>;
}

function aBruto(s: Segundo): Bruto {
  const pasos = new Map<Paso, Resumen>();
  for (const [paso, serie] of s.pasos) {
    const r = serie.valor;
    if (r) pasos.set(paso, r);
  }
  return {
    epoch: s.epoch,
    reqIniciadas: s.reqIniciadas, reqCompletadas: s.reqCompletadas, reqFallidas: s.reqFallidas,
    evIniciados: s.evIniciados, evCompletados: s.evCompletados, evDescartados: s.evDescartados,
    bytes: s.bytes, idsUnicos: s.idsUnicos, idsDuplicados: s.idsDuplicados,
    sqsLotes: s.sqsLotes, sqsMensajes: s.sqsMensajes, sqsOk: s.sqsOk,
    sqsReintento: s.sqsReintento, sqsFallidos: s.sqsFallidos,
    latencia: s.latencia.valor,
    pasos,
    pasosInit: new Map(s.pasosInit),
    pasosFin: new Map(s.pasosFin),
  };
}

function sumar(lista: Bruto[]): Bruto {
  const t: Bruto = {
    epoch: lista[0]?.epoch ?? 0,
    reqIniciadas: 0, reqCompletadas: 0, reqFallidas: 0,
    evIniciados: 0, evCompletados: 0, evDescartados: 0,
    bytes: 0, idsUnicos: 0, idsDuplicados: 0,
    sqsLotes: 0, sqsMensajes: 0, sqsOk: 0, sqsReintento: 0, sqsFallidos: 0,
    pasos: new Map(),
    pasosInit: new Map(),
    pasosFin: new Map(),
  };

  for (const b of lista) {
    t.reqIniciadas += b.reqIniciadas; t.reqCompletadas += b.reqCompletadas;
    t.reqFallidas += b.reqFallidas;
    t.evIniciados += b.evIniciados; t.evCompletados += b.evCompletados;
    t.evDescartados += b.evDescartados;
    t.bytes += b.bytes; t.idsUnicos += b.idsUnicos; t.idsDuplicados += b.idsDuplicados;
    t.sqsLotes += b.sqsLotes; t.sqsMensajes += b.sqsMensajes; t.sqsOk += b.sqsOk;
    t.sqsReintento += b.sqsReintento; t.sqsFallidos += b.sqsFallidos;
    for (const [p, v] of b.pasosInit) t.pasosInit.set(p, (t.pasosInit.get(p) ?? 0) + v);
    for (const [p, v] of b.pasosFin) t.pasosFin.set(p, (t.pasosFin.get(p) ?? 0) + v);
  }

  t.latencia = agregar(lista.map((b) => b.latencia));
  for (const paso of pasosPresentes(lista)) {
    const r = agregar(lista.map((b) => b.pasos.get(paso)));
    if (r) t.pasos.set(paso, r);
  }
  return t;
}

function pasosPresentes(lista: Bruto[]): Paso[] {
  const vistos = new Set<Paso>();
  for (const b of lista) for (const p of b.pasos.keys()) vistos.add(p);
  return [...vistos];
}

/** Agrupa los segundos en ventanas de `tamanoSeg`. */
function agrupar(crudos: Bruto[], tamanoSeg: number): Array<{ clave: number; bruto: Bruto }> {
  const cubos = new Map<number, Bruto[]>();
  for (const b of crudos) {
    const k = Math.floor(b.epoch / tamanoSeg);
    const l = cubos.get(k);
    if (l) l.push(b);
    else cubos.set(k, [b]);
  }
  return [...cubos.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([clave, lista]) => ({ clave, bruto: sumar(lista) }));
}

/**
 * @param aproximado los percentiles vienen de agregar ventanas, no de muestras.
 *                   Se declara en la salida para que nadie los cite como exactos.
 */
function presentar(b: Bruto, aproximado = false): MetricasSalida {
  // El orden de las claves ES el orden del JSON. Fijo y en el orden del
  // pipeline, no el de aparicion: un `sqs` antes de `canonical` se lee como si
  // el sobre hubiera viajado antes de firmarse.
  const steps: Partial<Record<Paso, PasoSalida>> = {};
  for (const paso of PASOS) {
    const p = presentarPaso(
      { init: b.pasosInit.get(paso) ?? 0, fin: b.pasosFin.get(paso) ?? 0 },
      b.pasos.get(paso),
      aproximado,
    );
    if (p) steps[paso] = p;
  }

  const lat = b.latencia;
  const request: MetricasSalida['request'] = {
    init: b.reqIniciadas,
    completed: b.reqCompletadas,
    failed: b.reqFallidas,
    latency_p50_ms: lat?.p50 ?? null,
    latency_p99_ms: lat?.p99 ?? null,
    latency_max_ms: lat?.max ?? null,
    latency_avg_ms: lat ? +(lat.suma / lat.n).toFixed(3) : null,
    samples: lat?.muestras ?? 0,
  };

  return {
    request,
    events: {
      init: b.evIniciados,
      completed: b.evCompletados,
      discarded: b.evDescartados,
      bytes: b.bytes,
      weight: legible(b.bytes),
      per_request: b.reqIniciadas === 0 ? null : +(b.evIniciados / b.reqIniciadas).toFixed(2),
      event_ids_unicos: b.idsUnicos,
      event_ids_duplicados: b.idsDuplicados,
      steps,
    },
    sqs: {
      batches: b.sqsLotes,
      messages: b.sqsMensajes,
      ok: b.sqsOk,
      retry: b.sqsReintento,
      failed: b.sqsFallidos,
    },
  };
}

/**
 * Lo que puede ir en un nombre de archivo. Exportada porque `GET /logs/:id`
 * arma el mismo sufijo para reconocerlo en el id: si cada uno lo saneara a su
 * manera, el endpoint buscaria un archivo con un nombre que nadie escribio.
 */
export const sanear = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, '-');
