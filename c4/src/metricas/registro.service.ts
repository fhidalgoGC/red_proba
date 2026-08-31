/**
 * G-11 · El informe de C4: `c4/logs/<prueba>__c4.json`.
 *
 * UN objeto JSON valido por corrida, con el detalle SEGUNDO A SEGUNDO, los
 * minutos agregados y el total. Se abre en cualquier editor, `jq .` lo formatea
 * entero y no hace falta parser propio. Misma forma que el de C3 y el del
 * orquestador: los tres se leen igual y se ponen uno al lado del otro.
 *
 * ────────────────────────────────────────────────────────────────────────
 * ESTE ARCHIVO NO ES EL VOLCADO DEL LEDGER
 *
 * En esta carpeta conviven dos JSON por corrida y NO son lo mismo:
 *
 *   <prueba>__c4.json      esto: el reloj del consumidor, por segundo, en
 *                          memoria. Contesta P1/P2/P3 desde el lado de C4.
 *   <prueba>__inbox.json   lo que escribe `npm run informe` (G-08) leyendo la
 *                          BASE. Contesta la mitad "llegado" de P4.
 *
 * El primero se pierde si muere la task y por eso se vuelca cada pocos
 * segundos; el segundo se puede regenerar siempre porque los datos estan en
 * Postgres. Confundirlos lleva a creer que P4 esta contestada cuando lo unico
 * que hay es un log de tiempos.
 * ────────────────────────────────────────────────────────────────────────
 *
 * ────────────────────────────────────────────────────────────────────────
 * DE DONDE SALE `<prueba>`
 *
 * Del `MessageAttribute` `prueba` del mensaje SQS, que escribe el relay de C3
 * copiando el `x-prueba-id` que le llego del orquestador. Ese atributo viaja
 * EN CLARO y FUERA del payload a proposito: el payload va firmado y meterle el
 * id de la corrida cambiaria lo que se firma (regla 8).
 *
 * Un mensaje sin el atributo —un productor viejo, o un veneno inyectado— cae
 * en la corrida `sin-id`. No se descarta: perderlo del log seria perder
 * justamente el caso raro.
 * ────────────────────────────────────────────────────────────────────────
 *
 * CUANDO SE ESCRIBE. Dos momentos, y ninguno es "al terminar la corrida":
 *
 *   1. cada FLUSH_MS mientras llega trafico   -> cerrado_por: "en curso"
 *   2. cuando la corrida lleva SILENCIO_MS callada, o llega SIGTERM
 *
 * El volcado periodico existe porque C4 no sabe cuando acaba la corrida — eso
 * lo sabe el orquestador. Sin el, un contenedor que muere a mitad de prueba se
 * llevaria el log entero, que es justo el caso en el que mas falta hace.
 *
 * ⚠ EL VOLCADO NO ES GRATIS: reescribe el archivo completo. Por eso el periodo
 * se estira cuando la serie crece (ver FLUSH_MS): un `JSON.stringify` de 10 MB
 * cada 10 segundos meteria pausas de GC justo dentro de lo que se esta
 * midiendo.
 */
import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigService } from '../config/config.service';
import { MetricasService, PASOS, PASOS_OBSERVADOS, SILENCIO_MS, type Paso, type Segundo } from './metricas.service';
import { agregar, legible, presentarPaso, type PasoSalida, type Resumen } from './muestras';

const TICK_MS = 1_000;

/**
 * Cada cuanto se reescribe el archivo de una corrida viva.
 *
 * Se estira a un minuto cuando la serie pasa de 600 segundos: a partir de ahi
 * el archivo pesa megas y reescribirlo cada 10 s competiria por CPU con el
 * consumidor que se esta midiendo — y C4 es el embudo, el sitio donde menos
 * conviene robar CPU.
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
 * la pregunta "¿esto lo mide el lote o el mensaje?" se contesta mirando en que
 * bloque cayo.
 */
export interface MetricasSalida {
  /**
   * Nivel LOTE — una respuesta de `ReceiveMessage`.
   *
   * Aqui vive la latencia del lote: un lote es UNA vuelta del lazo, lleve un
   * mensaje o diez. Es el analogo del `request` de C3, y por la misma razon:
   * no hay una "respuesta" por mensaje que se pueda cronometrar aparte.
   */
  batch: {
    /** Lotes que empezaron a procesarse. Se cuenta al LLEGAR. */
    init: number;
    /** Lotes que se procesaron enteros. No es el mismo segundo. */
    completed: number;
    /** Revento a mitad. No cuenta como completed. */
    failed: number;
    latency_p50_ms: number | null;
    latency_p99_ms: number | null;
    latency_max_ms: number | null;
    latency_avg_ms: number | null;
    /** Muestras detras de los percentiles. Menor que `completed` = techo. */
    samples?: number;
    /** Mensajes por lote. Cerca de `SQS_BATCH_SIZE` = la cola va llena. */
    per_batch: number | null;
  };

  /**
   * Nivel MENSAJE — los sobres que iban dentro de esos lotes.
   *
   * TRES COLUMNAS Y TRES RELOJES DISTINTOS, y esa es toda la gracia:
   *
   *   received   el lote LLEGO con el mensaje dentro
   *   init       al mensaje le TOCO su turno y empezo su trabajo
   *   completed  el mensaje TERMINO, con el desenlace que sea
   *
   * `received` va en rafagas: los diez de un lote entran a la vez, en el
   * segundo en que la cola los entrego. `init` los reparte segun cuando de
   * verdad les toco —el decimo empieza ~40 ms despues que el primero— y
   * `completed` segun cuando acabaron. Restar `received` de `completed` no
   * significa nada; restar `init` de `completed` si: son los que empezaron en
   * este segundo y no habian acabado al cerrarlo.
   *
   * ⚠ Antes `init` ERA `received`, y por eso una fila cualquiera salia
   * `init: 50 / completed: 50` un segundo tras otro: no era que todo empezara
   * y acabara en el mismo segundo, era que la columna venia del reloj del
   * lote y no del mensaje.
   */
  messages: {
    /** Llegaron dentro de esos lotes. Reloj de la RECEPCION, en rafagas. */
    received: number;
    /** Empezaron su trabajo en este segundo. Reloj REAL de cada mensaje. */
    init: number;
    /** Los que llegaron a un desenlace. La suma de los cuatro de abajo. */
    completed: number;
    /** Fila nueva en el inbox. Es el numerador de P4. */
    persisted: number;
    /** Ya estaba: reentrega absorbida por la idempotencia (regla 4). */
    duplicated: number;
    /** Veneno: no descifra, no verifica, o miente. A la DLQ con alarma (G-07). */
    discarded: number;
    /** Fallo transitorio: NO se borro, vuelve por la cola. No es una perdida. */
    retried: number;

    /** Bytes del SOBRE (lo que viajo por la cola, cifrado y en base64). */
    bytes: number;
    weight: string;
    /** Bytes del CANONICO en claro. Es el que se compara con el de C3. */
    bytes_canonicos: number;
    weight_canonicos: string;

    /**
     * `payload_hash` distintos vistos en la corrida, y cuantas veces se
     * repitio uno. Contra TODA la corrida, no contra este segundo.
     *
     * ⚠ `repetidos` NO ES UN ERROR: es la entrega al-menos-una-vez ocurriendo
     * (regla 4). Es el mismo hecho que la columna `duplicados` del inbox, pero
     * fechado al segundo — que es lo que permite ver si las reentregas se
     * concentran justo cuando el visibility timeout empieza a vencer.
     */
    payload_hash_unicos: number;
    payload_hash_repetidos: number;

    /**
     * Los tramos, en ms. Un paso que ni empezo NO aparece.
     *
     * `init` cae en el segundo en que el tramo EMPEZO y `completed` en el que
     * TERMINO. Que en una fila no coincidan es lo normal y es el dato: 45
     * descifrados iniciados y 0 terminados dice que KMS tiene 45 en vuelo.
     *
     * Omitir pesa menos que rellenar de ceros: en una corrida de 3.000
     * segundos, doce pasos vacios por segundo son 36.000 lineas que dicen
     * "aqui no paso nada". Y su ausencia informa: sin `dlq` en un segundo, en
     * ese segundo no hubo un solo veneno.
     *
     * ⚠ LA ARITMETICA CUADRA EN EL `total`, NO EN UNA FILA SUELTA:
     *
     *   envelope + decrypt + verify + hash + inbox  =  message
     *   Σ message + stamp + delete                  =  batch
     *
     * En una fila no tiene por que: los tramos de un mensaje que cruza la
     * frontera del segundo caen repartidos entre dos filas — que es justamente
     * lo que `init` vs `completed` esta ensenando.
     *
     * `wait` queda FUERA de esa suma a proposito: es lo que el mensaje espero
     * su turno dentro del lote, no trabajo. Sumarlo contaria dos veces el
     * procesamiento de los mensajes anteriores (04-medicion). `receive`
     * tambien queda fuera: es por ciclo, no por mensaje.
     */
    steps: Partial<Record<Paso, PasoSalida>>;
  };

  /**
   * El lazo contra la cola. `receives` son vueltas, no mensajes.
   *
   * `empty` es la senal que separa "C4 va sobrado" de "C4 no da abasto": si
   * los ciclos vacios desaparecen, la cola nunca se vacia y C4 es el cuello.
   */
  sqs: {
    receives: number;
    empty: number;
    failed: number;
    deleted: number;
    delete_failed: number;
    to_dlq: number;
  };

  /**
   * KMS, por segundo.
   *
   * `decrypt` creciendo al ritmo de `messages.init` significa que el cache de
   * data key dejo de acertar: cada mensaje se lleva una llamada a KMS y el
   * cuello se muda ahi. Es la linea que decide si P3 senala a KMS o a Postgres.
   */
  kms: {
    decrypt: number;
    cache_hit: number;
    get_public_key: number;
  };
}

interface SegundoSalida {
  /** 1-based desde el primer segundo con actividad de la corrida. */
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
  rol: 'operador-neutro';
  actualizado: string;
  inicio: string | null;
  fin: string | null;
  duracion_s: number;
  cerrado_por: string;
  /** Solo si la corrida supero el techo de segundos grabados. */
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

  private readonly dir: string;

  /** Ultimo volcado por corrida, para no reescribir en cada tick. */
  private readonly volcado = new Map<string, number>();
  /** Corridas ya cerradas. Si vuelve trafico se reabren. */
  private readonly cerradas = new Set<string>();
  /** El ultimo informe de cada corrida, para `GET /status`. */
  private readonly informes = new Map<string, Informe>();

  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly metricas: MetricasService,
    config: ConfigService,
  ) {
    // La MISMA carpeta que usa el CLI de G-08 y que sirve `GET /logs/:id`. Si
    // cada uno resolviera su ruta, el consumidor podria estar escribiendo
    // donde el endpoint no mira y el 404 no diria por que.
    this.dir = config.dirLogs;
  }

  onModuleInit(): void {
    mkdirSync(this.dir, { recursive: true });
    this.timer = setInterval(() => this.revisar(), TICK_MS);
    this.timer.unref();   // que un timer no impida cerrar el proceso
    this.logger.log(`informes por segundo en ${this.dir}`);
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    // Cerrar lo que quede abierto: sin esto se pierde el tramo final de cada
    // corrida, justo cuando mas interesa.
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
        // Volvio trafico despues del cierre: la corrida sigue viva y el
        // archivo tiene que volver a moverse. Pasa cuando el orquestador
        // arranca un segundo batch con el mismo id, o cuando una reentrega
        // llega tarde.
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
      `${t.batch.init} lotes · ${t.messages.received} mensajes · ` +
      `${t.messages.persisted} persistidos · ${t.messages.weight} · ` +
      `p50 ${t.messages.steps.message?.p50_ms ?? '-'} ms` +
      (t.messages.discarded > 0 ? `  ⚠ ${t.messages.discarded} DESCARTADOS` : '') +
      (t.messages.retried > 0 ? `  ⚠ ${t.messages.retried} en reintento` : ''),
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
      rol: 'operador-neutro',
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
   * `<prueba>__c4.json`, para una corrida cualquiera y no solo la viva.
   *
   * Publica porque `GET /logs/:id` la necesita: el nombre lo decide quien
   * escribe el archivo, asi que el que lo sirve pregunta en vez de volver a
   * construirlo — dos sitios armando la misma ruta es un 404 esperando a que
   * uno de los dos cambie el sufijo.
   *
   * ⚠ El sufijo `__c4` NO es decorativo: en esta carpeta tambien vive
   * `<prueba>__inbox.json`, que es otra cosa (el volcado del ledger, G-08).
   * Sin sufijos distintos, el CLI y el consumidor se pisarian el archivo y el
   * ultimo en escribir decidiria que se puede contestar.
   */
  ruta(prueba: string): string {
    return join(this.dir, `${sanear(prueba)}__c4.json`);
  }

  /**
   * Escritura atomica: temporal + rename.
   *
   * Se reescribe el archivo entero en cada volcado, asi que un fallo a media
   * escritura dejaria el JSON truncado y perderias la corrida completa, no
   * solo el ultimo tramo. Con rename, o esta el archivo viejo o el nuevo.
   */
  private guardar(prueba: string, informe: Informe): boolean {
    const destino = this.ruta(prueba);
    const temporal = destino + '.tmp';
    try {
      writeFileSync(temporal, JSON.stringify(informe, null, 2) + '\n', 'utf8');
      renameSync(temporal, destino);
      return true;
    } catch (e) {
      // Que no se pueda escribir el log NO debe tumbar al consumidor:
      // perderias la corrida entera por un problema de disco, y con ella P4.
      this.logger.error(`no se pudo escribir ${destino}: ${(e as Error).message}`);
      return false;
    }
  }

  // -------------------------------------------------------------------------

  get carpeta(): string { return this.dir; }

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
      logs: this.dir,
      pruebas: [...this.informes.values()].map((i) => ({
        prueba: i.prueba,
        lotes: i.total.batch.init,
        lotes_completados: i.total.batch.completed,
        mensajes: i.total.messages.received,
        persistidos: i.total.messages.persisted,
        duplicados: i.total.messages.duplicated,
        descartados: i.total.messages.discarded,
        reintentar: i.total.messages.retried,
        bytes: i.total.messages.bytes,
        payload_hash_unicos: i.total.messages.payload_hash_unicos,
        payload_hash_repetidos: i.total.messages.payload_hash_repetidos,
        // De la serie viva, no de `i.seconds`: el total de /status se
        // reconstruye sin armar la serie entera (armarla en cada llamada
        // costaria tanto como volcar el archivo).
        segundos: this.metricas.segundosDe(i.prueba).length,
        latency_p50_ms: i.total.batch.latency_p50_ms,
        latency_p99_ms: i.total.batch.latency_p99_ms,
        pasos: Object.fromEntries(
          Object.entries(i.total.messages.steps).map(([k, v]) => [k, v?.p50_ms ?? null]),
        ),
        kms: i.total.kms,
        cerrada: this.cerradas.has(i.prueba),
        archivo: i.archivo,
      })),
    };
  }

  /** El total de una corrida sin construir la serie entera. Para /status. */
  private soloTotal(prueba: string): Informe | null {
    this.metricas.comprimirTodo();
    const crudos = this.metricas.segundosDe(prueba).map(aBruto);
    if (crudos.length === 0) return null;
    const bordes = this.metricas.bordesDe(prueba);
    return {
      prueba,
      rol: 'operador-neutro',
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
  loteIniciados: number; loteCompletados: number; loteFallidos: number;
  msgRecibidos: number; msgIniciados: number; msgPersistidos: number; msgDuplicados: number;
  msgDescartados: number; msgReintentar: number;
  bytes: number; bytesCanonicos: number; hashUnicos: number; hashRepetidos: number;
  ciclos: number; ciclosVacios: number; ciclosFallidos: number;
  borrados: number; borradosFallidos: number; alaDlq: number;
  kmsDecrypt: number; kmsCache: number; kmsPubkey: number;
  latencia?: Resumen;
  pasos: Map<Paso, Resumen>;
  /** Ejecuciones por paso: empezadas y terminadas. Van aparte del `Resumen`
   *  porque un paso que revento no deja muestra, pero si deja un `init`. */
  pasosInit: Map<Paso, number>;
  pasosFin: Map<Paso, number>;
  /** Terminadas aqui que habian empezado en un segundo anterior. */
  pasosCruce: Map<Paso, number>;
}

function aBruto(s: Segundo): Bruto {
  const pasos = new Map<Paso, Resumen>();
  for (const [paso, serie] of s.pasos) {
    const r = serie.valor;
    if (r) pasos.set(paso, r);
  }
  return {
    epoch: s.epoch,
    loteIniciados: s.loteIniciados, loteCompletados: s.loteCompletados,
    loteFallidos: s.loteFallidos,
    msgRecibidos: s.msgRecibidos, msgIniciados: s.msgIniciados,
    msgPersistidos: s.msgPersistidos,
    msgDuplicados: s.msgDuplicados, msgDescartados: s.msgDescartados,
    msgReintentar: s.msgReintentar,
    bytes: s.bytes, bytesCanonicos: s.bytesCanonicos,
    hashUnicos: s.hashUnicos, hashRepetidos: s.hashRepetidos,
    ciclos: s.ciclos, ciclosVacios: s.ciclosVacios, ciclosFallidos: s.ciclosFallidos,
    borrados: s.borrados, borradosFallidos: s.borradosFallidos, alaDlq: s.alaDlq,
    kmsDecrypt: s.kmsDecrypt, kmsCache: s.kmsCache, kmsPubkey: s.kmsPubkey,
    latencia: s.latencia.valor,
    pasos,
    pasosInit: new Map(s.pasosInit),
    pasosFin: new Map(s.pasosFin),
    pasosCruce: new Map(s.pasosCruce),
  };
}

function sumar(lista: Bruto[]): Bruto {
  const t: Bruto = {
    epoch: lista[0]?.epoch ?? 0,
    loteIniciados: 0, loteCompletados: 0, loteFallidos: 0,
    msgRecibidos: 0, msgIniciados: 0, msgPersistidos: 0, msgDuplicados: 0,
    msgDescartados: 0, msgReintentar: 0,
    bytes: 0, bytesCanonicos: 0, hashUnicos: 0, hashRepetidos: 0,
    ciclos: 0, ciclosVacios: 0, ciclosFallidos: 0,
    borrados: 0, borradosFallidos: 0, alaDlq: 0,
    kmsDecrypt: 0, kmsCache: 0, kmsPubkey: 0,
    pasos: new Map(),
    pasosInit: new Map(),
    pasosFin: new Map(),
    pasosCruce: new Map(),
  };

  for (const b of lista) {
    t.loteIniciados += b.loteIniciados; t.loteCompletados += b.loteCompletados;
    t.loteFallidos += b.loteFallidos;
    t.msgRecibidos += b.msgRecibidos; t.msgIniciados += b.msgIniciados;
    t.msgPersistidos += b.msgPersistidos;
    t.msgDuplicados += b.msgDuplicados; t.msgDescartados += b.msgDescartados;
    t.msgReintentar += b.msgReintentar;
    t.bytes += b.bytes; t.bytesCanonicos += b.bytesCanonicos;
    t.hashUnicos += b.hashUnicos; t.hashRepetidos += b.hashRepetidos;
    t.ciclos += b.ciclos; t.ciclosVacios += b.ciclosVacios;
    t.ciclosFallidos += b.ciclosFallidos;
    t.borrados += b.borrados; t.borradosFallidos += b.borradosFallidos;
    t.alaDlq += b.alaDlq;
    t.kmsDecrypt += b.kmsDecrypt; t.kmsCache += b.kmsCache; t.kmsPubkey += b.kmsPubkey;
    for (const [p, v] of b.pasosInit) t.pasosInit.set(p, (t.pasosInit.get(p) ?? 0) + v);
    for (const [p, v] of b.pasosFin) t.pasosFin.set(p, (t.pasosFin.get(p) ?? 0) + v);
    for (const [p, v] of b.pasosCruce) t.pasosCruce.set(p, (t.pasosCruce.get(p) ?? 0) + v);
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
  // pipeline, no el de aparicion: un `inbox` antes de `decrypt` se lee como si
  // el evento se hubiera persistido antes de abrirlo.
  const steps: Partial<Record<Paso, PasoSalida>> = {};
  for (const paso of PASOS) {
    const p = presentarPaso(
      {
        init: b.pasosInit.get(paso) ?? 0,
        fin: b.pasosFin.get(paso) ?? 0,
        cruce: b.pasosCruce.get(paso) ?? 0,
      },
      b.pasos.get(paso),
      aproximado,
      PASOS_OBSERVADOS.has(paso),
    );
    if (p) steps[paso] = p;
  }

  const lat = b.latencia;
  const resueltos =
    b.msgPersistidos + b.msgDuplicados + b.msgDescartados + b.msgReintentar;

  return {
    batch: {
      init: b.loteIniciados,
      completed: b.loteCompletados,
      failed: b.loteFallidos,
      latency_p50_ms: lat?.p50 ?? null,
      latency_p99_ms: lat?.p99 ?? null,
      latency_max_ms: lat?.max ?? null,
      latency_avg_ms: lat ? +(lat.suma / lat.n).toFixed(3) : null,
      samples: lat?.muestras ?? 0,
      per_batch: b.loteIniciados === 0 ? null : +(b.msgRecibidos / b.loteIniciados).toFixed(2),
    },
    messages: {
      received: b.msgRecibidos,
      init: b.msgIniciados,
      completed: resueltos,
      persisted: b.msgPersistidos,
      duplicated: b.msgDuplicados,
      discarded: b.msgDescartados,
      retried: b.msgReintentar,
      bytes: b.bytes,
      weight: legible(b.bytes),
      bytes_canonicos: b.bytesCanonicos,
      weight_canonicos: legible(b.bytesCanonicos),
      payload_hash_unicos: b.hashUnicos,
      payload_hash_repetidos: b.hashRepetidos,
      steps,
    },
    sqs: {
      receives: b.ciclos,
      empty: b.ciclosVacios,
      failed: b.ciclosFallidos,
      deleted: b.borrados,
      delete_failed: b.borradosFallidos,
      to_dlq: b.alaDlq,
    },
    kms: {
      decrypt: b.kmsDecrypt,
      cache_hit: b.kmsCache,
      get_public_key: b.kmsPubkey,
    },
  };
}

/**
 * Lo que puede ir en un nombre de archivo. Exportada porque `GET /logs/:id`
 * arma el mismo sufijo para reconocerlo en el id: si cada uno lo saneara a su
 * manera, el endpoint buscaria un archivo con un nombre que nadie escribio.
 */
export const sanear = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, '-');
