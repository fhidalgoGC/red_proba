/**
 * C-09 · Las metricas de C3, segundo a segundo y por prueba.
 *
 * Este service NO escribe archivos: solo acumula. El que vuelca a
 * `c3/logs/<prueba>__<tenant>.json` es `registro.service.ts`.
 *
 * ────────────────────────────────────────────────────────────────────────
 * POR QUE POR SEGUNDO
 *
 * Igual que el informe del orquestador, y por la misma razon: un promedio por
 * minuto esconde exactamente lo que se busca. Un p99 de firma de 80 ms puede
 * ser un ritmo plano o dos segundos de 900 ms entre 58 de 12 — y el segundo
 * caso es la respuesta a P3 (donde esta el limite), mientras el promedio dice
 * que todo va bien.
 *
 INIT NO ES COMPLETED
 *
 *   init       C3 recibio la peticion. Se cuenta al LLEGAR.
 *   completed  C3 contesto 202. Se cuenta al RESPONDER.
 *
 * No cuadran dentro del mismo segundo, y ese desfase ES la latencia: lo que
 * entro en el segundo 5 puede completarse en el 6. Cuando el pipeline se
 * atasca, `init` mantiene su ritmo y `completed` se hunde — y esa separacion
 * es justo lo que hay que poder ver. Es el mismo par que `sent`/`completed`
 * del orquestador, visto desde el otro lado del cable.
 *
 * `failed` es la peticion que reventó: no hubo 202. No es `completed`.
 *
 * El MISMO par baja a cada paso: `canonical.init` / `canonical.completed`, y
 * asi los ocho. `init - completed` son las ejecuciones que entraron y no
 * salieron: o el documento se DESCARTO ahi (`events.discarded` lo cuenta, y
 * solo ocurre en `canonical`), o el tramo REVENTO. En los dos casos dice EN
 * QUE PASO se quedo el lote.
 * ────────────────────────────────────────────────────────────────────────
 *
 * ────────────────────────────────────────────────────────────────────────
 * CADA TRAMO SE GRABA EN SU SEGUNDO REAL
 *
 * `init` se anota en el segundo en que el tramo EMPEZO y `completed` en el que
 * TERMINO. Son dos momentos distintos y a menudo dos segundos distintos: un
 * documento que entra a firmar en el segundo 4 y vuelve de KMS en el 6 suma
 * `sign.init` en el 4 y `sign.completed` en el 6.
 *
 * Que los dos numeros de una fila coincidan NO es lo normal — significa que en
 * ese segundo no habia nada a medio hacer. En cuanto la firma tarda, `init`
 * mantiene su ritmo y `completed` se hunde, y esa separacion, tramo a tramo,
 * es lo que dice DONDE se acumula el trabajo sin terminar.
 *
 * ⚠ CONSECUENCIA EN LA ARITMETICA. Dentro de UNA fila, la suma de los tramos
 * NO tiene por que dar `pipeline`: los tramos de una peticion que cruza la
 * frontera del segundo caen repartidos. La igualdad se cumple en el TOTAL,
 * donde cada ejecucion se cuenta exactamente una vez:
 *
 *   total: canonical.suma_ms + sign.suma_ms + encrypt.suma_ms + outbox.suma_ms
 *            = pipeline.suma_ms
 *   total: pipeline.suma_ms + delay.suma_ms  ≈  latencia total
 *
 * ────────────────────────────────────────────────────────────────────────
 * POR QUE ESTO ADEMAS DA PERCENTILES EXACTOS
 *
 * Una muestra se anota SIEMPRE en el segundo en curso. Cuando el reloj pasa de
 * segundo, a ese segundo ya no le puede llegar nada mas: se comprime UNA vez,
 * sobre sus muestras crudas, y sus percentiles son EXACTOS.
 *
 * No es gratis por casualidad — es justo lo que se rompia al acumular los
 * tramos de una peticion y volcarlos al final: entonces a un segundo ya
 * cerrado le seguian llegando muestras, habia que fundir resumenes ponderando,
 * y el percentil dejaba de ser el percentil.
 * ────────────────────────────────────────────────────────────────────────
 *
 * LOS OCHO PASOS. Los seis primeros son de la peticion; los dos ultimos, del
 * relay, que corre en su propio timer y no dentro de ningun request:
 *
 *   canonical  e0→e1  validar + party_id + JCS + payload_hash   (por documento)
 *   sign       e1→e2  KMS Sign                                  (por documento)
 *   encrypt    e2→e3  data key + AES-256-GCM                    (por documento)
 *   outbox     e3→e4  la transaccion de negocio                 (por peticion)
 *   pipeline   e0→e4  el loop entero, entrada a commit          (por peticion)
 *   delay      e4→r   el retardo artificial de C3_DELAY_MS      (por peticion)
 *   wait       e4→e5  lo que la fila espero en el outbox        (por fila)
 *   sqs        e5→e6  SendMessageBatch                          (por lote)
 *
 * ⚠ `pipeline` NO es la latencia de la peticion: es solo el trabajo. La
 * latencia (`request`) le suma el parseo del cuerpo, la respuesta y el retardo
 * artificial. `delay` existe para que ese ultimo sumando NO quede escondido —
 * sin el, una perilla de prueba de 300 ms aparece como un hueco inexplicable
 * entre `pipeline` y la latencia, y alguien lo lee como coste del sistema.
 */
import { Injectable } from '@nestjs/common';
import { Serie, agregar, ahora, msDesde, type Resumen } from './muestras';

export const PASOS = [
  'canonical',
  'sign',
  'encrypt',
  'outbox',
  'pipeline',
  'delay',
  'wait',
  'sqs',
] as const;
export type Paso = (typeof PASOS)[number];

/**
 * Los pasos que NO pertenecen a una peticion: los mide el relay, en su propio
 * timer y despues de que el 202 ya se contesto. Este proceso los observa ya
 * terminados, asi que su `init` y su `completed` caen forzosamente juntos.
 */
export const PASOS_DEL_RELAY: ReadonlySet<Paso> = new Set<Paso>(['wait', 'sqs']);

export const SIN_ID = 'sin-id';

/**
 * Techo de segundos grabados por prueba. 4 horas cubre de sobra el perfil
 * completo de docs/04-orquestador.md (3 h 28 min). Al pasarlo se deja de
 * grabar el detalle por segundo, pero NO en silencio: el informe lo declara en
 * `seconds_truncated`. Un log truncado sin avisar se lee como completo.
 */
const SEGUNDOS_MAXIMOS = 14_400;

/** Lo que se acumula en un segundo de una prueba. */
export interface Segundo {
  epoch: number;

  // ── nivel PETICION ──
  reqIniciadas: number;
  reqCompletadas: number;
  reqFallidas: number;

  // ── nivel EVENTO ──
  evIniciados: number;
  evCompletados: number;
  evDescartados: number;
  bytes: number;
  idsUnicos: number;
  idsDuplicados: number;

  // ── SQS (del relay) ──
  sqsLotes: number;
  sqsMensajes: number;
  sqsOk: number;
  sqsReintento: number;
  sqsFallidos: number;

  /** Latencia de la peticion completa, en ms. */
  latencia: Serie;
  /** Una serie por paso. Se crean solo si hay muestras. */
  pasos: Map<Paso, Serie>;
  /** Ejecuciones que EMPEZARON, por paso. */
  pasosInit: Map<Paso, number>;
  /** Ejecuciones que TERMINARON, por paso. Menor que init = revento a mitad. */
  pasosFin: Map<Paso, number>;
}

function vacio(epoch: number): Segundo {
  return {
    epoch,
    reqIniciadas: 0, reqCompletadas: 0, reqFallidas: 0,
    evIniciados: 0, evCompletados: 0, evDescartados: 0,
    bytes: 0, idsUnicos: 0, idsDuplicados: 0,
    sqsLotes: 0, sqsMensajes: 0, sqsOk: 0, sqsReintento: 0, sqsFallidos: 0,
    latencia: new Serie(),
    pasos: new Map(),
    pasosInit: new Map(),
    pasosFin: new Map(),
  };
}

@Injectable()
export class MetricasService {
  /** Una serie de segundos por prueba. Clave externa: prueba; interna: epoch. */
  private readonly series = new Map<string, Map<number, Segundo>>();
  /** `event_id` ya vistos, por prueba. Detecta duplicados entre segundos. */
  private readonly vistos = new Map<string, Set<string>>();
  /** Pruebas que pasaron SEGUNDOS_MAXIMOS. El informe lo dice. */
  private readonly truncadas = new Set<string>();
  /** Primer y ultimo instante con actividad, por prueba. */
  private readonly bordes = new Map<string, { primera: number; ultima: number }>();

  // -------------------------------------------------------------------------
  // Entrada
  // -------------------------------------------------------------------------

  /**
   * Una peticion acaba de llegar. Se anota ANTES de procesarla: la llegada
   * ocurrio ya, y anotarla despues la moveria al segundo equivocado — que es
   * exactamente el desfase que este log existe para medir.
   */
  entrada(prueba: string | undefined, documentos: unknown[], bytes: number): void {
    const id = normalizar(prueba);
    const s = this.casilla(id);
    s.reqIniciadas += 1;
    s.evIniciados += documentos.length;
    s.bytes += bytes;

    // Los event_id se comparan contra TODA la prueba, no solo contra este
    // segundo: un duplicado que cruza la frontera del segundo sigue siendo un
    // duplicado, y es exactamente el fallo que SQS FIFO se tragaria en
    // silencio durante 5 minutos (regla 11).
    let global = this.vistos.get(id);
    if (!global) { global = new Set(); this.vistos.set(id, global); }

    for (const d of documentos) {
      const ev = (d as { event_id?: unknown })?.event_id;
      if (typeof ev !== 'string') continue;
      if (global.has(ev)) s.idsDuplicados += 1;
      else { global.add(ev); s.idsUnicos += 1; }
    }
  }

  /** C3 contesto 202. `ms` es la peticion COMPLETA, retardo artificial incluido. */
  completada(prueba: string | undefined, ms: number, aceptados: number, descartados: number): void {
    const s = this.casilla(normalizar(prueba));
    s.reqCompletadas += 1;
    s.evCompletados += aceptados;
    s.evDescartados += descartados;
    s.latencia.push(ms);
  }

  /**
   * La peticion reventó: no hubo 202.
   *
   * No se cuenta como `completed` y su latencia no entra en los percentiles:
   * el tiempo hasta un fallo no es tiempo de servicio, y meterlo movería el
   * p99 por una causa que no es de rendimiento.
   *
   * El rastro de POR DONDE IBA no se pierde: cada tramo ya anoto su `init` en
   * el segundo en que empezo. Un lote que revento en la firma deja
   * `sign.init` sin su `completed`, y eso señala el tramo sin que haga falta
   * leer un log de texto.
   */
  fallida(prueba: string | undefined, _ms: number): void {
    this.casilla(normalizar(prueba)).reqFallidas += 1;
  }

  /**
   * El tramo EMPIEZA. Se llama ANTES de hacer el trabajo, nunca despues: la
   * gracia de `init` es caer en el segundo en que arranco, y anotarlo al
   * volver lo movería al segundo en que acabo — que es lo que ya cuenta
   * `completed`.
   */
  abre(prueba: string | undefined, paso: Paso): void {
    const s = this.casilla(normalizar(prueba));
    s.pasosInit.set(paso, (s.pasosInit.get(paso) ?? 0) + 1);
  }

  /** El tramo TERMINA bien, tras `ms`. Cae en el segundo en que termino. */
  cierra(prueba: string | undefined, paso: Paso, ms: number): void {
    const s = this.casilla(normalizar(prueba));
    s.pasosFin.set(paso, (s.pasosFin.get(paso) ?? 0) + 1);
    let serie = s.pasos.get(paso);
    if (!serie) { serie = new Serie(); s.pasos.set(paso, serie); }
    serie.push(ms);
  }

  /**
   * Abre y cierra de una vez. Para los tramos que el proceso OBSERVA ya
   * terminados en vez de ejecutarlos: `wait` y `sqs`, que el relay mide en su
   * propio timer cuando el 202 ya se contesto. Ahi no hay un "empezo" que
   * este proceso pueda situar en un segundo distinto.
   */
  paso(prueba: string | undefined, paso: Paso, ms: number): void {
    const id = normalizar(prueba);
    this.abre(id, paso);
    this.cierra(id, paso, ms);
  }

  /**
   * Un `SendMessageBatch` volvio. Lo llama el RELAY, no un request.
   *
   * ⚠ `ms` es la duracion de la LLAMADA, no de un mensaje: SendMessageBatch
   * lleva hasta 10 sobres en una sola. Por eso `sqs.batches` va al lado de
   * `sqs.messages` — dividir uno por otro es lo unico que hace comparable este
   * tramo con los de la peticion, que si son por documento.
   */
  publicacion(
    prueba: string | undefined,
    ms: number,
    c: { mensajes: number; ok: number; reintento: number; fallidos: number },
  ): void {
    const id = normalizar(prueba);
    const s = this.casilla(id);
    s.sqsLotes += 1;
    s.sqsMensajes += c.mensajes;
    s.sqsOk += c.ok;
    s.sqsReintento += c.reintento;
    s.sqsFallidos += c.fallidos;
    this.paso(id, 'sqs', ms);
  }

  // -------------------------------------------------------------------------
  // Lectura
  // -------------------------------------------------------------------------

  /** La serie de una prueba, ordenada por segundo. */
  segundosDe(prueba: string): Segundo[] {
    return [...(this.series.get(prueba)?.values() ?? [])].sort((a, b) => a.epoch - b.epoch);
  }

  get pruebas(): string[] { return [...this.series.keys()]; }

  truncada(prueba: string): boolean { return this.truncadas.has(prueba); }

  bordesDe(prueba: string): { primera: number; ultima: number } | undefined {
    return this.bordes.get(prueba);
  }

  /** Ms desde la ultima actividad de la prueba. Es lo que decide el cierre. */
  silencioDe(prueba: string): number {
    const b = this.bordes.get(prueba);
    return b === undefined ? Infinity : Date.now() - b.ultima;
  }

  /**
   * Cierra los segundos YA TERMINADOS que sigan con muestras crudas.
   *
   * Se llama antes de volcar. El segundo EN CURSO se deja en paz a proposito:
   * comprimirlo funde percentiles de un tramo con los del resto del segundo y
   * los vuelve aproximados sin necesidad. Leerlo no hace falta comprimirlo —
   * `Serie.valor` no muta y ya devuelve lo pendiente.
   *
   * @param hasta epoch a partir del cual NO se comprime. Por defecto, el
   *              segundo en curso.
   */
  comprimirTodo(hasta = Math.floor(Date.now() / 1000)): void {
    for (const porSegundo of this.series.values()) {
      for (const s of porSegundo.values()) {
        if (s.epoch >= hasta) continue;
        s.latencia.comprimir();
        for (const serie of s.pasos.values()) serie.comprimir();
      }
    }
  }

  /** Suelta lo acumulado de una prueba. La llama el registro tras el volcado final. */
  olvidar(prueba: string): void {
    this.series.delete(prueba);
    this.vistos.delete(prueba);
    this.truncadas.delete(prueba);
    this.bordes.delete(prueba);
  }

  // -------------------------------------------------------------------------

  /**
   * El segundo en curso de una prueba, creandolo si hace falta.
   *
   * Al abrir un segundo nuevo se comprimen los anteriores y se liberan sus
   * arrays: es lo que hace viable una corrida de horas.
   */
  private casilla(prueba: string): Segundo {
    const t = Date.now();
    const epoch = Math.floor(t / 1000);

    const borde = this.bordes.get(prueba);
    if (borde) borde.ultima = t;
    else this.bordes.set(prueba, { primera: t, ultima: t });

    let porSegundo = this.series.get(prueba);
    if (!porSegundo) { porSegundo = new Map(); this.series.set(prueba, porSegundo); }

    const s = porSegundo.get(epoch);
    if (s) return s;

    for (const viejo of porSegundo.values()) {
      if (viejo.epoch === epoch) continue;
      viejo.latencia.comprimir();
      for (const serie of viejo.pasos.values()) serie.comprimir();
    }

    if (porSegundo.size >= SEGUNDOS_MAXIMOS) {
      this.truncadas.add(prueba);
      return vacio(epoch);   // desechable: se cuenta en el vacio, no se guarda
    }

    const nuevo = vacio(epoch);
    porSegundo.set(epoch, nuevo);
    return nuevo;
  }
}

/**
 * Un id de prueba ausente o con forma rara no puede acabar en un nombre de
 * archivo. Es idempotente: `normalizar(normalizar(x)) === normalizar(x)`, y de
 * eso depende poder normalizar en el borde (el controlador) y otra vez aqui
 * sin que la clave cambie.
 */
export function normalizar(prueba: string | undefined | null): string {
  if (!prueba) return SIN_ID;
  const s = prueba.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(s) ? s : SIN_ID;
}

/** Reexportadas para que quien instrumenta no importe de dos sitios. */
export { ahora, msDesde, agregar, type Resumen };
