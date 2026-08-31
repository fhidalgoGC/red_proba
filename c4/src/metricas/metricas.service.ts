/**
 * G-11 · Las metricas de C4, segundo a segundo y por corrida.
 *
 * Este service NO escribe archivos: solo acumula. El que vuelca a
 * `c4/logs/<prueba>__c4.json` es `registro.service.ts`.
 *
 * Es el gemelo del de C3 (`c3/src/metricas/metricas.service.ts`), con los
 * pasos del otro extremo del cable. Que los dos midan igual —mismo `Serie`,
 * mismo techo, mismo par `init`/`completed`— es lo que permite poner un p99 de
 * C3 al lado de uno de C4 y que la comparacion signifique algo.
 *
 * ────────────────────────────────────────────────────────────────────────
 * POR QUE POR SEGUNDO
 *
 * Un promedio por minuto esconde exactamente lo que se busca. Un p99 de
 * descifrado de 80 ms puede ser un ritmo plano o dos segundos de 900 ms entre
 * 58 de 12 — y el segundo caso es la respuesta a P3 (donde esta el limite),
 * mientras el promedio dice que todo va bien.
 *
 * Y en C4 hace mas falta que en C3: C4 es el EMBUDO. Los 50 tenants publican a
 * una cola y este proceso la consume solo, en serie dentro de cada lote. Si
 * algo se satura primero, se satura aqui.
 * ────────────────────────────────────────────────────────────────────────
 *
 * ────────────────────────────────────────────────────────────────────────
 * INIT NO ES COMPLETED
 *
 *   init       el lote/mensaje/tramo EMPEZO. Se cuenta al ARRANCAR.
 *   completed  TERMINO bien. Se cuenta al ACABAR.
 *
 * No cuadran dentro del mismo segundo, y ese desfase ES la latencia: un lote
 * que entra en el segundo 5 puede cerrarse en el 7. Cuando C4 se atasca,
 * `init` mantiene su ritmo y `completed` se hunde — y esa separacion es justo
 * lo que hay que poder ver.
 *
 * El MISMO par baja a cada paso: `decrypt.init` / `decrypt.completed`, y asi
 * los doce. `init - completed` son las ejecuciones que entraron y no salieron:
 * el mensaje se fue por el camino del veneno (`messages.discarded`), se dejo
 * en la cola para reintento (`messages.retried`), o el tramo REVENTO. En los
 * tres casos dice EN QUE PASO se quedo.
 * ────────────────────────────────────────────────────────────────────────
 *
 * ────────────────────────────────────────────────────────────────────────
 * CADA TRAMO SE GRABA EN SU SEGUNDO REAL
 *
 * `init` se anota en el segundo en que el tramo EMPEZO y `completed` en el que
 * TERMINO. Un mensaje que entra a descifrar en el segundo 4 y vuelve de KMS en
 * el 6 suma `decrypt.init` en el 4 y `decrypt.completed` en el 6.
 *
 * ⚠ CONSECUENCIA EN LA ARITMETICA. Dentro de UNA fila, la suma de los tramos
 * NO tiene por que dar `message`: los tramos de un mensaje que cruza la
 * frontera del segundo caen repartidos. La igualdad se cumple en el TOTAL,
 * donde cada ejecucion se cuenta exactamente una vez:
 *
 *   total: envelope + decrypt + verify + hash + inbox  =  message
 *   total: Σ message + stamp + delete                  =  batch
 * ────────────────────────────────────────────────────────────────────────
 *
 * LOS DOCE PASOS. Los siete primeros son por MENSAJE, tres por LOTE, uno por
 * CICLO del lazo y uno por veneno:
 *
 *   wait      e7→e7b    lo que el mensaje espero su turno dentro del lote
 *   envelope  e7b→      parsear y validar la envoltura, sin abrirla
 *   decrypt   →e8       KMS Decrypt (o cache) + AES-256-GCM
 *   verify    →e9       GetPublicKey (cache) + Ed25519
 *   hash      —         recanonizar el payload y recalcular payload_hash
 *   inbox     e9→e10    la transaccion: inbox + los cinco schemas
 *   message   e7b→e10   el trabajo del mensaje entero
 *   dlq       —         publicar el veneno y anotar el descarte  (por veneno)
 *   stamp     —         el UPDATE de e10 del lote                (por lote)
 *   delete    —         DeleteMessageBatch                       (por lote)
 *   batch     e7→       el lote entero: procesar, estampar, borrar (por lote)
 *   receive   —         ReceiveMessage                           (por ciclo)
 *
 * ⚠ `wait` NO ES TRABAJO, y separarlo es la razon de que exista `e7b`. Un
 * `ReceiveMessage` devuelve hasta 10 mensajes en el MISMO instante y se
 * procesan en serie: sin `wait`, el tramo del ultimo mensaje del lote
 * incluiria el procesamiento de los nueve anteriores y el informe diria
 * «descifrar tarda 400 ms» cuando descifrar tarda 3. Es senal de saturacion,
 * no de coste (04-medicion).
 *
 * ⚠ `receive` INCLUYE LA ESPERA DEL LONG POLLING. Un ciclo vacio se pasa 20 s
 * dentro de esa llamada esperando a que llegue algo, y eso no es coste de C4:
 * es cola vacia. Por eso solo se mide en los ciclos que TRAJERON mensajes, y
 * aun asi hay que leerlo como «cuanto tardo en haber trabajo», no como
 * «cuanto cuesta recibir». El ritmo de la cola se lee en `sqs.empty`.
 */
import { Injectable } from '@nestjs/common';
import { Serie, agregar, ahora, msDesde, type Resumen } from './muestras';

export const PASOS = [
  'wait',
  'envelope',
  'decrypt',
  'verify',
  'hash',
  'inbox',
  'message',
  'dlq',
  'stamp',
  'delete',
  'batch',
  'receive',
] as const;
export type Paso = (typeof PASOS)[number];

/**
 * Los pasos que este proceso OBSERVA ya terminados en vez de ejecutarlos:
 * `wait` es el hueco entre dos instantes que ya pasaron. No hay un "empezo"
 * que se pueda situar en un segundo distinto del "termino".
 */
export const PASOS_OBSERVADOS: ReadonlySet<Paso> = new Set<Paso>(['wait', 'receive']);

export const SIN_ID = 'sin-id';

/**
 * Techo de segundos grabados por corrida. 4 horas cubre de sobra el perfil
 * completo de docs/04-orquestador.md (3 h 28 min). Al pasarlo se deja de
 * grabar el detalle por segundo, pero NO en silencio: el informe lo declara en
 * `seconds_truncated`. Un log truncado sin avisar se lee como completo.
 */
const SEGUNDOS_MAXIMOS = 14_400;

/**
 * Silencio real tras el que una corrida se da por terminada.
 *
 * ⚠ VIVE AQUI, no en el registro, porque este archivo es el que decide QUE
 * cuenta como actividad — y de eso depende que el numero signifique algo.
 *
 * ⚠ MAS LARGO QUE EL DE C3 (8 s), y no por capricho. C3 ve la peticion HTTP en
 * cuanto el orquestador la manda; C4 ve el mensaje cuando el relay lo publica Y
 * la cola se lo entrega. Entre medias hay un outbox que sondea cada
 * OUTBOX_POLL_MS y un long polling de hasta 20 s. Con el umbral de C3, una cola
 * que tarda en entregar cerraria el informe y lo reabriria en bucle.
 */
export const SILENCIO_MS = 45_000;

/** Lo que se acumula en un segundo de una corrida. */
export interface Segundo {
  epoch: number;

  // ── nivel LOTE (una respuesta de ReceiveMessage) ──
  loteIniciados: number;
  loteCompletados: number;
  loteFallidos: number;

  // ── nivel MENSAJE ──
  /** Llegaron dentro de un lote. Reloj de la RECEPCION. */
  msgRecibidos: number;
  /** Les toco el turno y empezo su trabajo. Reloj REAL de cada mensaje. */
  msgIniciados: number;
  msgPersistidos: number;
  msgDuplicados: number;
  msgDescartados: number;
  msgReintentar: number;
  bytes: number;
  bytesCanonicos: number;
  hashUnicos: number;
  hashRepetidos: number;

  // ── SQS y KMS ──
  ciclos: number;
  ciclosVacios: number;
  ciclosFallidos: number;
  borrados: number;
  borradosFallidos: number;
  alaDlq: number;
  kmsDecrypt: number;
  kmsCache: number;
  kmsPubkey: number;

  /** Latencia del LOTE completo, en ms. */
  latencia: Serie;
  /** Una serie por paso. Se crean solo si hay muestras. */
  pasos: Map<Paso, Serie>;
  /** Ejecuciones que EMPEZARON, por paso. */
  pasosInit: Map<Paso, number>;
  /** De las terminadas aqui, cuantas habian EMPEZADO en un segundo anterior. */
  pasosCruce: Map<Paso, number>;
  /** Ejecuciones que TERMINARON, por paso. Menor que init = revento a mitad. */
  pasosFin: Map<Paso, number>;
}

function vacio(epoch: number): Segundo {
  return {
    epoch,
    loteIniciados: 0, loteCompletados: 0, loteFallidos: 0,
    msgRecibidos: 0, msgIniciados: 0, msgPersistidos: 0, msgDuplicados: 0,
    msgDescartados: 0, msgReintentar: 0,
    bytes: 0, bytesCanonicos: 0, hashUnicos: 0, hashRepetidos: 0,
    ciclos: 0, ciclosVacios: 0, ciclosFallidos: 0,
    borrados: 0, borradosFallidos: 0, alaDlq: 0,
    kmsDecrypt: 0, kmsCache: 0, kmsPubkey: 0,
    latencia: new Serie(),
    pasos: new Map(),
    pasosInit: new Map(),
    pasosFin: new Map(),
    pasosCruce: new Map(),
  };
}

@Injectable()
export class MetricasService {
  /** Una serie de segundos por corrida. Clave externa: prueba; interna: epoch. */
  private readonly series = new Map<string, Map<number, Segundo>>();
  /** `payload_hash` ya vistos, por corrida. Detecta reentregas entre segundos. */
  private readonly vistos = new Map<string, Set<string>>();
  /** Corridas que pasaron SEGUNDOS_MAXIMOS. El informe lo dice. */
  private readonly truncadas = new Set<string>();
  /** Primer y ultimo instante con actividad, por corrida. */
  private readonly bordes = new Map<string, { primera: number; ultima: number }>();

  // -------------------------------------------------------------------------
  // Entrada
  // -------------------------------------------------------------------------

  /**
   * Un ciclo del lazo volvio de `ReceiveMessage`.
   *
   * Un ciclo VACIO se anota igual: es la senal que separa "C4 va sobrado" de
   * "C4 no da abasto". Si los ciclos vacios desaparecen, la cola nunca se vacia
   * y el cuello es C4.
   *
   * `ms` solo se mide cuando el ciclo TRAJO algo: en un ciclo vacio la llamada
   * se pasa los 20 s del long polling esperando, y eso es cola vacia, no coste.
   *
   * ⚠ UN SONDEO EN VACIO NO ES ACTIVIDAD DE LA CORRIDA, y esto costo una
   * corrida entera de log. El lazo sigue sondeando para siempre despues de que
   * la prueba acabe: si cada sondeo refrescara el reloj de silencio, la corrida
   * NUNCA se daria por terminada. El sintoma no es un error — es un
   * `cerrado_por: "en curso"` permanente, un `duracion_s` que crece sin parar y
   * una fila por cada 20 s de cola vacia hasta agotar SEGUNDOS_MAXIMOS. Medido:
   * una corrida de 10 s aparecia con 259 s de duracion.
   *
   * Asi que el ciclo vacio (1) no toca el reloj de silencio y (2) solo se anota
   * mientras la corrida siga viva. Una corrida que acabo, acabo.
   */
  ciclo(prueba: string | undefined, vacia: boolean, ms: number | null): void {
    const id = normalizar(prueba);
    if (vacia) {
      if (this.silencioDe(id) >= SILENCIO_MS) return;
      const s = this.casilla(id, false);
      s.ciclos += 1;
      s.ciclosVacios += 1;
      return;
    }
    const s = this.casilla(id);
    s.ciclos += 1;
    if (ms !== null) this.paso(id, 'receive', ms);
  }

  /**
   * El `ReceiveMessage` revento. No es un lote fallido: no llego a haber lote.
   *
   * Se trata igual que el ciclo vacio —no es actividad de la corrida— por la
   * misma razon: una cola que deja de contestar lo hace indefinidamente, y si
   * cada error extendiera la corrida, el informe de una prueba de 10 s crecerira
   * mientras el fallo dure. Los errores que caen DENTRO de la corrida si se
   * anotan, que es donde importan.
   */
  cicloFallido(prueba: string | undefined): void {
    const id = normalizar(prueba);
    if (this.silencioDe(id) >= SILENCIO_MS) return;
    const s = this.casilla(id, false);
    s.ciclos += 1;
    s.ciclosFallidos += 1;
  }

  /**
   * Llego un lote. Se anota ANTES de procesarlo: la llegada ocurrio ya, y
   * anotarla despues la moveria al segundo equivocado — que es exactamente el
   * desfase que este log existe para medir.
   *
   * @param mensajes los de ESTA corrida dentro del lote, no los del lote
   *                 entero. Un lote puede traer mensajes de dos corridas
   *                 solapadas y cada una lleva su propio archivo.
   * @param bytes    bytes del SOBRE, que es lo que viajo por la cola.
   */
  lote(prueba: string | undefined, mensajes: number, bytes: number): void {
    const s = this.casilla(normalizar(prueba));
    s.loteIniciados += 1;
    s.msgRecibidos += mensajes;
    s.bytes += bytes;
  }

  /** El lote se proceso entero, en `ms`. Cae en el segundo en que termino. */
  loteCompletado(prueba: string | undefined, ms: number): void {
    const s = this.casilla(normalizar(prueba));
    s.loteCompletados += 1;
    s.latencia.push(ms);
  }

  /**
   * El lote revento a mitad.
   *
   * Su latencia NO entra en los percentiles: el tiempo hasta un fallo no es
   * tiempo de servicio, y meterlo moveria el p99 por una causa que no es de
   * rendimiento. El rastro de POR DONDE IBA no se pierde: cada tramo ya anoto
   * su `init` en el segundo en que empezo.
   */
  loteFallido(prueba: string | undefined): void {
    this.casilla(normalizar(prueba)).loteFallidos += 1;
  }

  /**
   * Como acabo un mensaje. Es el desglose de `messages.completed`.
   *
   * ⚠ EL HASH SE COMPARA CONTRA TODA LA CORRIDA, no contra este segundo: una
   * reentrega que cruza la frontera del segundo sigue siendo una reentrega. Es
   * la evidencia EN VIVO de que la entrega al-menos-una-vez (regla 4) esta
   * ocurriendo — la version persistida es la columna `duplicados` del inbox,
   * pero esa no dice EN QUE SEGUNDO paso, y el momento importa: las
   * reentregas se agolpan justo cuando el visibility timeout empieza a vencer.
   *
   * Se pasa el hash RECALCULADO, no el `MessageDeduplicationId` declarado. El
   * declarado lo escribio el emisor y viaja en claro: contar reentregas con el
   * seria dejar que el emisor decida cuantas hubo.
   *
   * @param hash null cuando el mensaje ni llego a tener uno (no era un sobre,
   *             no descifro). Esos no cuentan como unicos ni como repetidos:
   *             se cuentan en `discarded`, que es lo que son.
   */
  mensaje(
    prueba: string | undefined,
    estado: 'persistido' | 'duplicado' | 'descartado' | 'reintentar',
    hash: string | null = null,
    bytesCanonicos = 0,
  ): void {
    const id = normalizar(prueba);
    const s = this.casilla(id);
    if (estado === 'persistido') s.msgPersistidos += 1;
    else if (estado === 'duplicado') s.msgDuplicados += 1;
    else if (estado === 'descartado') s.msgDescartados += 1;
    else s.msgReintentar += 1;
    s.bytesCanonicos += bytesCanonicos;

    if (!hash) return;
    let global = this.vistos.get(id);
    if (!global) { global = new Set(); this.vistos.set(id, global); }
    if (global.has(hash)) s.hashRepetidos += 1;
    else { global.add(hash); s.hashUnicos += 1; }
  }

  /** Lo que el `DeleteMessageBatch` confirmo y lo que no. */
  borrado(prueba: string | undefined, ok: number, fallidos: number): void {
    const s = this.casilla(normalizar(prueba));
    s.borrados += ok;
    s.borradosFallidos += fallidos;
  }

  /** Un mensaje se publico en la DLQ (G-07). */
  dlq(prueba: string | undefined): void {
    this.casilla(normalizar(prueba)).alaDlq += 1;
  }

  /**
   * Llamadas a KMS del segundo.
   *
   * Se cuentan aparte de los tramos porque el numero que importa no es el
   * tiempo sino la RAZON: si `decrypt` crece al ritmo de `messages.init`, el
   * cache de data key dejo de acertar y el coste de KMS se multiplica por el
   * numero de mensajes. Es la lectura de una sola linea que decide si P3
   * senala a KMS o a Postgres.
   */
  kms(prueba: string | undefined, c: { decrypt?: number; cache?: number; pubkey?: number }): void {
    const s = this.casilla(normalizar(prueba));
    s.kmsDecrypt += c.decrypt ?? 0;
    s.kmsCache += c.cache ?? 0;
    s.kmsPubkey += c.pubkey ?? 0;
  }

  /**
   * El tramo EMPIEZA. Se llama ANTES de hacer el trabajo, nunca despues: la
   * gracia de `init` es caer en el segundo en que arranco, y anotarlo al
   * volver lo moveria al segundo en que acabo — que es lo que ya cuenta
   * `completed`.
   */
  abre(prueba: string | undefined, paso: Paso): void {
    const s = this.casilla(normalizar(prueba));
    s.pasosInit.set(paso, (s.pasosInit.get(paso) ?? 0) + 1);
  }

  /**
   * A UN mensaje le toca su turno: empieza su trabajo AQUI.
   *
   * Abre el tramo `message` y cuenta el arranque en el mismo movimiento, y por
   * eso es una sola llamada y no dos: `messages.init` y `message.init` cuentan
   * el mismo hecho y separarlos en dos llamadas seguidas es dejarlos derivar
   * en cuanto alguien mueva una de las dos.
   *
   * ⚠ NO es lo mismo que `lote()`. El lote anota los diez mensajes que trajo
   * en el segundo en que LLEGO; este anota cada mensaje en el segundo en que
   * de verdad empezo a procesarse. Con un lote de 10 a ~5 ms por mensaje, los
   * ultimos empiezan 40 ms despues que el primero — y si el lote cayo cerca
   * del borde, en el segundo siguiente. Confundir los dos reloj hace que
   * `init` y `completed` de la misma fila no sean comparables.
   */
  empieza(prueba: string | undefined): void {
    const s = this.casilla(normalizar(prueba));
    s.msgIniciados += 1;
    s.pasosInit.set('message', (s.pasosInit.get('message') ?? 0) + 1);
  }

  /**
   * El tramo TERMINA bien, tras `ms`. Cae en el segundo en que termino.
   *
   * Y de paso responde la pregunta que `init`/`completed` deja abierta: ESTA
   * ejecucion, ¿empezo en este segundo o en uno anterior? Se sabe sin guardar
   * nada, porque la duracion ya la tenemos: el instante de arranque es
   * `fin - ms`. Si cae en un epoch anterior, es un CRUCE.
   *
   * Sin este contador, que un segundo cierre 50 con 50 abiertos se lee como
   * "todo empezo y acabo aqui" cuando puede ser "empezaron 50 y acabaron otros
   * 50, y ninguno de los dos grupos es el mismo". Con el, la fila lo dice.
   */
  cierra(prueba: string | undefined, paso: Paso, ms: number): void {
    const s = this.casilla(normalizar(prueba));
    s.pasosFin.set(paso, (s.pasosFin.get(paso) ?? 0) + 1);

    const fin = Date.now();
    if (Math.floor((fin - ms) / 1000) < Math.floor(fin / 1000)) {
      s.pasosCruce.set(paso, (s.pasosCruce.get(paso) ?? 0) + 1);
    }

    let serie = s.pasos.get(paso);
    if (!serie) { serie = new Serie(); s.pasos.set(paso, serie); }
    serie.push(ms);
  }

  /**
   * Abre y cierra de una vez. Para los tramos que el proceso OBSERVA ya
   * terminados en vez de ejecutarlos —`wait`, que es el hueco entre dos
   * instantes que ya pasaron—. Ahi no hay un "empezo" que este proceso pueda
   * situar en un segundo distinto.
   */
  paso(prueba: string | undefined, paso: Paso, ms: number): void {
    const id = normalizar(prueba);
    this.abre(id, paso);
    this.cierra(id, paso, ms);
  }

  // -------------------------------------------------------------------------
  // Lectura
  // -------------------------------------------------------------------------

  /** La serie de una corrida, ordenada por segundo. */
  segundosDe(prueba: string): Segundo[] {
    return [...(this.series.get(prueba)?.values() ?? [])].sort((a, b) => a.epoch - b.epoch);
  }

  get pruebas(): string[] { return [...this.series.keys()]; }

  truncada(prueba: string): boolean { return this.truncadas.has(prueba); }

  bordesDe(prueba: string): { primera: number; ultima: number } | undefined {
    return this.bordes.get(prueba);
  }

  /** Ms desde la ultima actividad de la corrida. Es lo que decide el cierre. */
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

  /** Suelta lo acumulado de una corrida. La llama el registro tras el volcado final. */
  olvidar(prueba: string): void {
    this.series.delete(prueba);
    this.vistos.delete(prueba);
    this.truncadas.delete(prueba);
    this.bordes.delete(prueba);
  }

  // -------------------------------------------------------------------------

  /**
   * El segundo en curso de una corrida, creandolo si hace falta.
   *
   * Al abrir un segundo nuevo se comprimen los anteriores y se liberan sus
   * arrays: es lo que hace viable una corrida de horas a 2.000 msg/s.
   *
   * @param actividad si esto cuenta como "la corrida sigue viva". Falso para
   *                  los sondeos en vacio y los fallos de la cola, que ocurren
   *                  para siempre despues de que la prueba acabe (ver `ciclo`).
   */
  private casilla(prueba: string, actividad = true): Segundo {
    const t = Date.now();
    const epoch = Math.floor(t / 1000);

    const borde = this.bordes.get(prueba);
    if (borde) { if (actividad) borde.ultima = t; }
    else if (actividad) this.bordes.set(prueba, { primera: t, ultima: t });

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
 * Un id de corrida ausente o con forma rara no puede acabar en un nombre de
 * archivo. Es idempotente: `normalizar(normalizar(x)) === normalizar(x)`, y de
 * eso depende poder normalizar en el borde (al leer el atributo del mensaje) y
 * otra vez aqui sin que la clave cambie.
 *
 * ⚠ El id llega en un MessageAttribute que viaja EN CLARO y lo escribio C3.
 * Es dato de fuera: sin esta guarda, un atributo con `../..` acabaria en el
 * nombre de un archivo que escribe el operador neutro.
 */
export function normalizar(prueba: string | undefined | null): string {
  if (!prueba) return SIN_ID;
  const s = prueba.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(s) ? s : SIN_ID;
}

/** Reexportadas para que quien instrumenta no importe de dos sitios. */
export { ahora, msDesde, agregar, type Resumen };
