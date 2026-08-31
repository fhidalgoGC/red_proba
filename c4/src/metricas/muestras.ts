/**
 * Muestras de tiempo y su resumen. La parte pura de la medicion de C4.
 *
 * ⚠ GEMELO DE `c3/src/metricas/muestras.ts`, y duplicado a proposito. Entre C3
 * y C4 no hay paquete compartido porque no hay nada compartido: son dos
 * builds, dos imagenes y dos dominios sin ruta de red entre ellos (D-03). Lo
 * unico que cruza es la cola. Si esta aritmetica deriva de la de C3, el
 * sintoma no es un fallo: es que un p99 de C3 y uno de C4 dejan de ser
 * comparables, y toda la lectura de P3 —"¿que componente se satura
 * primero?"— se hace sobre dos escalas distintas sin que nada avise.
 *
 * ────────────────────────────────────────────────────────────────────────
 * POR QUE `hrtime` Y NO LAS MARCAS e7..e10
 *
 * Las marcas del inbox son ISO 8601: resolucion de MILISEGUNDO. Verificar
 * Ed25519 sobre 3 KB es sub-milisegundo y el AES-GCM del sobre tambien: los
 * dos tramos saldrian en 0 ms y el informe diria que descifrar y verificar
 * son gratis.
 *
 * Las marcas siguen existiendo y siguen siendo las que van a las columnas del
 * inbox — son lo que permite conciliar contra el outbox de C3 y sobreviven al
 * proceso. Estas muestras son lo OTRO: duracion, no instante. Se toman con
 * `process.hrtime.bigint()`, que es monotono (no lo mueve un ajuste de NTP a
 * mitad de corrida) y tiene resolucion de nanosegundo.
 * ────────────────────────────────────────────────────────────────────────
 */

/** Un instante monotono. No es una hora: no se puede comparar entre procesos. */
export const ahora = (): bigint => process.hrtime.bigint();

/** Milisegundos entre dos instantes monotonos, con 3 decimales. */
export const msDesde = (desde: bigint, hasta: bigint = ahora()): number =>
  +(Number(hasta - desde) / 1e6).toFixed(3);

/**
 * Resumen de un conjunto de muestras.
 *
 * Las muestras crudas se comprimen a esto EN CUANTO el segundo pasa y el array
 * se libera. Retenerlas seria inviable: una corrida de 4 horas a 2.000 ev/s
 * —C4 ve el trafico de los 50 tenants junto— son ~29 millones de numeros por
 * paso, y hay doce pasos.
 *
 * ⚠ DOS CONTEOS, Y NO SON EL MISMO:
 *
 *   n         ejecuciones medidas. EXACTO, siempre.
 *   muestras  las que se retuvieron para los percentiles. `n` o menos.
 *
 * `n`, `suma` y `max` se acumulan por muestra en O(1) y NO les afecta el techo
 * de `MUESTRAS_MAX`: son exactos aunque se hayan tirado muestras. Los
 * percentiles salen solo de `muestras`.
 *
 * Esa separacion es lo que hace que las sumas de los pasos cuadren. Si `suma`
 * viniera del array recortado, un segundo con 553 ejecuciones y 500 muestras
 * declararia el tiempo de 500 — y `envelope + decrypt + verify + hash + inbox`
 * ya no daria `message`, sin un solo error a la vista. En C4 esto NO es
 * hipotetico: el techo se alcanza en cuanto la corrida pasa de 500 msg/s.
 */
export interface Resumen {
  /** Ejecuciones medidas. Exacto. */
  n: number;
  /** Muestras detras de los percentiles. `<= n` por el techo. */
  muestras: number;
  p50: number;
  p95: number;
  p99: number;
  /**
   * Exactos sobre las `n`, no sobre las `muestras`.
   *
   * El par min/max es lo que hace VISIBLE que cada ejecucion duro lo suyo. Un
   * p50 solo no lo prueba: un tramo que tarda siempre exactamente igual y otro
   * que oscila entre 0,04 y 0,19 ms pueden dar el mismo p50, y descifrar un
   * documento de 2 KB no puede costar lo mismo que uno de 4.
   */
  min: number;
  max: number;
  /** Exacto sobre las `n`. Es el campo que cuadra la aritmetica. */
  suma: number;
  /**
   * Los percentiles salieron de FUNDIR dos juegos, no de ordenar muestras.
   *
   * En el camino normal NUNCA se pone: una muestra cae siempre en el segundo
   * en curso, y a un segundo ya cerrado no le llega nada mas, asi que se
   * comprime una sola vez y el percentil es el percentil. La bandera esta para
   * que si alguna vez ese invariante se rompe, la perdida de exactitud SALGA
   * AL JSON en vez de pasar por exacta.
   */
  fundido?: true;
}

/**
 * Techo de muestras por segundo, por serie.
 *
 * ⚠ C4 ES EL EMBUDO Y AQUI EL TECHO SI SE TOCA. Los 50 tenants de C3 publican
 * a UNA cola y C4 la consume solo: donde un C3 ve ~40 ev/s, C4 ve los 2.000
 * del perfil completo. Con lotes de 10 y proceso en serie eso son cuatro
 * veces el techo por segundo, asi que los percentiles de C4 salen de una
 * MUESTRA y no de todo — y por eso `muestras` viaja al JSON al lado de `n`.
 *
 * Lo que el techo NO toca: `n`, `suma` y `max` se acumulan al entrar cada
 * muestra y siguen siendo exactos. La media y los totales de C4 son de la
 * corrida entera aunque el p99 sea de 500 mensajes de ese segundo.
 *
 * ⚠ El techo afecta SOLO a los percentiles. `n`, `suma` y `max` se acumulan al
 * entrar cada muestra y siguen siendo exactos. Cuando se alcanza, `muestras`
 * queda por debajo de `n` y los dos salen al JSON para que la diferencia se
 * vea: un percentil sobre muestra parcial no se cita como si fuera de todo.
 */
export const MUESTRAS_MAX = 500;

/**
 * Acumula muestras de un segundo y las comprime cuando el segundo termina.
 *
 * ────────────────────────────────────────────────────────────────────────
 * DOS INVARIANTES QUE COSTARON UNA CORRIDA ENTERA
 *
 * 1. `comprimir()` ACUMULA, no reemplaza. La version anterior hacia
 *    `this.resumen = comprimir(this.crudas)`, y eso tiraba lo ya comprimido:
 *    un segundo vivo que se comprimia en un volcado periodico y despues
 *    recibia mas muestras perdia el primer lote. Se veia como `completed: 30`
 *    con `n: 25` — cinco peticiones medidas cuyo tiempo desaparecio del
 *    informe sin un solo error.
 *
 * 2. `valor` NO MUTA. Antes comprimia al leer, asi que un `GET /status` sobre
 *    el segundo en curso disparaba exactamente el caso de arriba.
 *
 * Los dos juntos: leer es gratis y comprimir nunca pierde nada.
 * ────────────────────────────────────────────────────────────────────────
 */
export class Serie {
  /** Solo para los percentiles. Con techo. */
  private crudas: number[] = [];
  /** Exactos, por muestra y en O(1). El techo NO les afecta. */
  private n = 0;
  private suma = 0;
  private max = 0;
  private min = Infinity;
  /** Percentiles ya comprimidos, y cuantas muestras hay detras. */
  private pct: { p50: number; p95: number; p99: number; muestras: number } | undefined;
  /** Se comprimio mas de una vez: los percentiles ya no son exactos. */
  private fundido = false;

  push(ms: number): void {
    // El total, el maximo y el conteo se llevan SIEMPRE: son tres sumas y no
    // cuestan memoria. Es lo que mantiene `suma` exacta cuando el techo tira
    // muestras, y con ella la aritmetica de los pasos.
    this.n += 1;
    this.suma += ms;
    if (ms > this.max) this.max = ms;
    if (ms < this.min) this.min = ms;

    // Se descarta la muestra que pasa del techo, no la mas vieja: sustituirla
    // costaria un indice aleatorio por muestra en el camino caliente para
    // ganar una representatividad que a 40 ev/s no hace falta.
    if (this.crudas.length < MUESTRAS_MAX) this.crudas.push(ms);
  }

  /**
   * Comprime los percentiles pendientes y libera el array.
   *
   * ACUMULATIVA: si ya habia percentiles, los funde ponderando por muestras en
   * vez de pisarlos. En el camino normal se llama UNA vez, sobre un segundo ya
   * cerrado, y entonces los percentiles son exactos. La fusion es la red de
   * seguridad para cuando no.
   */
  comprimir(): void {
    if (this.crudas.length === 0) return;
    const nuevo = percentiles(this.crudas);
    if (this.pct === undefined) this.pct = nuevo;
    else { this.pct = fundir(this.pct, nuevo); this.fundido = true; }
    this.crudas = [];
  }

  /** El resumen. NO muta: leerlo no comprime ni pierde nada. */
  get valor(): Resumen | undefined {
    if (this.n === 0) return undefined;
    const pendiente = this.crudas.length > 0 ? percentiles(this.crudas) : undefined;
    const mezcla = this.pct !== undefined && pendiente !== undefined;
    const p = mezcla ? fundir(this.pct!, pendiente!) : (this.pct ?? pendiente);
    return {
      ...(this.fundido || mezcla ? { fundido: true as const } : {}),
      n: this.n,
      muestras: p?.muestras ?? 0,
      p50: p?.p50 ?? 0,
      p95: p?.p95 ?? 0,
      p99: p?.p99 ?? 0,
      min: +this.min.toFixed(3),
      max: +this.max.toFixed(3),
      suma: +this.suma.toFixed(3),
    };
  }
}

interface Pct { p50: number; p95: number; p99: number; muestras: number }

/** Percentiles EXACTOS de un array de muestras. */
function percentiles(muestras: number[]): Pct {
  const orden = [...muestras].sort((a, b) => a - b);
  const q = (p: number): number =>
    +orden[Math.min(orden.length - 1, Math.ceil((p / 100) * orden.length) - 1)]!.toFixed(3);
  return { p50: q(50), p95: q(95), p99: q(99), muestras: orden.length };
}

/** Funde dos juegos de percentiles ponderando por muestras. */
function fundir(a: Pct, b: Pct): Pct {
  const m = a.muestras + b.muestras;
  const w = (x: number, y: number): number => +((x * a.muestras + y * b.muestras) / m).toFixed(3);
  return { p50: w(a.p50, b.p50), p95: w(a.p95, b.p95), p99: w(a.p99, b.p99), muestras: m };
}

/** Resumen EXACTO de un conjunto de muestras, sin pasar por la Serie. */
export function comprimir(muestras: number[]): Resumen {
  const p = percentiles(muestras);
  return {
    n: muestras.length,
    muestras: p.muestras,
    p50: p.p50,
    p95: p.p95,
    p99: p.p99,
    min: +Math.min(...muestras).toFixed(3),
    max: +Math.max(...muestras).toFixed(3),
    suma: +muestras.reduce((a, b) => a + b, 0).toFixed(3),
  };
}

/**
 * Agrega resumenes de varias ventanas en uno.
 *
 * ⚠ LOS PERCENTILES SALEN APROXIMADOS y el nombre del campo lo dice
 * (`aproximado: true`). Un percentil de percentiles no es el percentil real:
 * se ponderan por numero de muestras, que es lo mejor que se puede hacer sin
 * retener las muestras crudas de la corrida entera. `max` y la media SI son
 * exactos — el maximo de maximos es el maximo, y la suma de sumas sobre la
 * suma de `n` es la media de verdad.
 */
export function agregar(lista: Array<Resumen | undefined>): Resumen | undefined {
  let n = 0, muestras = 0, p50 = 0, p95 = 0, p99 = 0, suma = 0;
  let max: number | null = null;
  let min: number | null = null;

  for (const r of lista) {
    if (r === undefined || r.n === 0) continue;
    // `n` y `suma` suman TODAS las ejecuciones; los percentiles se ponderan
    // por las MUESTRAS que hay detras de cada uno. Ponderar por `n` daria mas
    // peso a una ventana que recorto muestras que a una que las conservo
    // todas — justo al reves de lo que representa el numero.
    n += r.n;
    suma += r.suma;
    max = max === null ? r.max : Math.max(max, r.max);
    // min y max se agregan EXACTOS: son extremos, no percentiles. Agregar
    // ventanas no los degrada, asi que no llevan `aproximado`.
    min = min === null ? r.min : Math.min(min, r.min);
    if (r.muestras === 0) continue;
    muestras += r.muestras;
    p50 += r.p50 * r.muestras;
    p95 += r.p95 * r.muestras;
    p99 += r.p99 * r.muestras;
  }
  if (n === 0) return undefined;

  return {
    n,
    muestras,
    p50: muestras === 0 ? 0 : +(p50 / muestras).toFixed(3),
    p95: muestras === 0 ? 0 : +(p95 / muestras).toFixed(3),
    p99: muestras === 0 ? 0 : +(p99 / muestras).toFixed(3),
    min: min!,
    max: max!,
    suma: +suma.toFixed(3),
  };
}

/**
 * Un paso, tal como sale al JSON.
 *
 * `init` y `completed` son el mismo par que en `request`, un nivel mas abajo:
 * cuantas ejecuciones del tramo EMPEZARON y cuantas TERMINARON.
 *
 * `init - completed` son las que ENTRARON Y NO SALIERON, y hay tres motivos
 * posibles: el mensaje se fue por el camino del veneno ahi (`messages.discarded`
 * lo cuenta), se dejo en la cola para reintento (`messages.retried`), o el
 * tramo REVENTO. Cual de los tres es se decide mirando esos dos contadores;
 * que el tramo no cerro, lo dice este par. Es lo que señala EN QUE PASO se
 * quedo un mensaje que nunca llego a `e10`.
 *
 * `n` son las ejecuciones MEDIDAS y `muestras` las que hay detras de los
 * percentiles. Se separan cuando se alcanza MUESTRAS_MAX, y los dos salen al
 * JSON — un percentil sobre muestra parcial no se cita como si fuera de todo.
 *
 * `suma_ms`, `avg_ms` y `max_ms` son EXACTOS sobre las `n`, no sobre las
 * `muestras`: se acumulan por muestra al entrar y el techo no les afecta. Sin
 * eso, un segundo que recorto muestras declararia menos tiempo del que gasto y
 * `envelope + decrypt + verify + hash + inbox` dejaria de dar `message`.
 *
 * `suma_ms` sale explicita porque es lo unico que se puede SUMAR entre pasos:
 * un promedio no se suma, un total si.
 */
export interface PasoSalida {
  /** Ejecuciones que empezaron. */
  init: number;
  /** Ejecuciones que terminaron. `init - completed` = descartadas o reventadas. */
  completed: number;
  /**
   * De las que terminaron aqui, cuantas habian EMPEZADO en un segundo anterior.
   *
   * Se omite cuando es 0. Es la respuesta directa a la duda que `init` y
   * `completed` dejan abierta: que las dos columnas valgan 50 no dice si son
   * los mismos 50. `crossed: 7` dice que siete de los que cerraron aqui venian
   * del segundo de antes.
   *
   * No se guarda nada para calcularlo: el instante de arranque es `fin - ms` y
   * la duracion ya se estaba midiendo.
   */
  crossed?: number;
  /** Ejecuciones medidas. Igual a `completed` salvo que algo no se instrumente. */
  n: number;
  /** Muestras detras de los percentiles. Menor que `n` = se alcanzo el techo. */
  muestras: number;
  /**
   * El mas rapido y el mas lento de la ventana. Exactos sobre las `n`.
   *
   * Van juntos y no se omiten nunca: son la prueba, dentro de la propia fila,
   * de que cada ejecucion se midio por separado. `min_ms` = `max_ms` con `n`
   * grande significa que algo esta repitiendo una medida, no midiendo.
   */
  min_ms: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  /** Exacto sobre las `n`. */
  max_ms: number;
  /** Exacto: `suma_ms / n`. */
  avg_ms: number;
  /** Total del tramo en la ventana. Es el campo que cuadra la aritmetica. */
  suma_ms: number;
  /** Solo cuando los percentiles vienen de agregar ventanas. */
  aproximado?: true;

  /**
   * ⚠ TRAMO OBSERVADO: `init` y `completed` son el MISMO instante por
   * definicion, no por medicion.
   *
   * `wait` y `receive` no los EJECUTA este proceso: son huecos entre dos
   * instantes que ya pasaron cuando C4 se entera. No hay un "empezo" que
   * situar en un segundo distinto del "termino", asi que sus dos columnas
   * seran identicas SIEMPRE, dure el tramo 20 ms o 20 s.
   *
   * Se declara en el JSON porque sin la bandera esas filas se leen como una
   * medicion sospechosamente plana: `receive` con 127 ms de media y jamas un
   * cruce de segundo es exactamente lo que parece un reloj falso. Los tramos
   * que C4 SI ejecuta no la llevan, y ahi el cruce ocurre — o no ocurre
   * porque el tramo dura microsegundos, que es otra cosa y se ve en `min_ms`.
   */
  observado?: true;
}

/**
 * @param cuenta las ejecuciones del tramo en la ventana. Va aparte del resumen
 *               porque un paso puede EMPEZAR sin dejar muestra (revento), y
 *               entonces no hay `Resumen` que lo cuente.
 */
export function presentarPaso(
  cuenta: { init: number; fin: number; cruce?: number },
  r: Resumen | undefined,
  aproximado = false,
  observado = false,
): PasoSalida | undefined {
  // Un percentil fundido tampoco es exacto: se declara igual que uno agregado.
  aproximado = aproximado || r?.fundido === true;
  // Un paso que ni empezo no aparece: en una corrida de 3.000 segundos, doce
  // pasos a cero por segundo son 36.000 lineas que dicen "aqui no paso nada".
  if (cuenta.init === 0 && (r === undefined || r.n === 0)) return undefined;
  return {
    init: cuenta.init,
    completed: cuenta.fin,
    ...(cuenta.cruce ? { crossed: cuenta.cruce } : {}),
    ...(observado ? { observado: true as const } : {}),
    n: r?.n ?? 0,
    muestras: r?.muestras ?? 0,
    min_ms: r?.min ?? 0,
    p50_ms: r?.p50 ?? 0,
    p95_ms: r?.p95 ?? 0,
    p99_ms: r?.p99 ?? 0,
    max_ms: r?.max ?? 0,
    avg_ms: r && r.n > 0 ? +(r.suma / r.n).toFixed(3) : 0,
    suma_ms: r?.suma ?? 0,
    ...(aproximado ? { aproximado: true as const } : {}),
  };
}

/**
 * Bytes legibles. Va SIEMPRE junto al numero crudo, nunca en su lugar: un
 * "200 KB" en texto no se puede sumar, ni graficar, ni comparar con el conteo
 * de C3 ni con el del orquestador.
 */
export function legible(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
