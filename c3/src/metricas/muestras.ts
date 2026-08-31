/**
 * Muestras de tiempo y su resumen. La parte pura de la medicion de C3.
 *
 * ────────────────────────────────────────────────────────────────────────
 * POR QUE `hrtime` Y NO LAS MARCAS e0..e6
 *
 * Las marcas del outbox son ISO 8601: resolucion de MILISEGUNDO. En local,
 * canonizar un documento de 3 KB tarda ~0,05 ms y firmar en modo local ~0,08:
 * los dos tramos salen en 0 ms y el informe diria que el pipeline es gratis.
 *
 * Las marcas siguen existiendo y siguen siendo las que van a las columnas —
 * son lo que permite conciliar contra el inbox de C4 y sobreviven al proceso.
 * Estas muestras son lo OTRO: duracion, no instante. Se toman con
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
 * se libera. Retenerlas seria inviable: una corrida de 4 horas a 40 ev/s son
 * ~600.000 numeros por paso y hay siete pasos.
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
 * declararia el tiempo de 500 — y `canonical + sign + encrypt + outbox` ya no
 * daria `pipeline`, sin un solo error a la vista.
 */
export interface Resumen {
  /** Ejecuciones medidas. Exacto. */
  n: number;
  /** Muestras detras de los percentiles. `<= n` por el techo. */
  muestras: number;
  p50: number;
  p95: number;
  p99: number;
  /** Exacto sobre las `n`, no sobre las `muestras`. */
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
 * Un contenedor de C3 ve ~40 ev/s en el perfil completo (2.000 ev/s
 * repartidos entre 50 tenants), muy por debajo del techo: los percentiles
 * salen exactos. El techo esta para el caso patologico —un solo tenant
 * recibiendo la corrida entera— donde 500 muestras siguen dando un p99 solido
 * y evitan que el array crezca sin limite dentro del segundo.
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

  for (const r of lista) {
    if (r === undefined || r.n === 0) continue;
    // `n` y `suma` suman TODAS las ejecuciones; los percentiles se ponderan
    // por las MUESTRAS que hay detras de cada uno. Ponderar por `n` daria mas
    // peso a una ventana que recorto muestras que a una que las conservo
    // todas — justo al reves de lo que representa el numero.
    n += r.n;
    suma += r.suma;
    max = max === null ? r.max : Math.max(max, r.max);
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
 * `init - completed` son las que ENTRARON Y NO SALIERON, y hay dos motivos
 * posibles: el documento se DESCARTO ahi (entonces `events.discarded` lo
 * cuenta, y solo pasa en `canonical`), o el tramo REVENTO. Cual de los dos es
 * se decide mirando `discarded`; que el tramo no cerro, lo dice este par. Es
 * lo que señala EN QUE PASO se rompio un lote que no llego a 202.
 *
 * `n` son las ejecuciones MEDIDAS y `muestras` las que hay detras de los
 * percentiles. Se separan cuando se alcanza MUESTRAS_MAX, y los dos salen al
 * JSON — un percentil sobre muestra parcial no se cita como si fuera de todo.
 *
 * `suma_ms`, `avg_ms` y `max_ms` son EXACTOS sobre las `n`, no sobre las
 * `muestras`: se acumulan por muestra al entrar y el techo no les afecta. Sin
 * eso, un segundo que recorto muestras declararia menos tiempo del que gasto y
 * `canonical + sign + encrypt + outbox` dejaria de dar `pipeline`.
 *
 * `suma_ms` sale explicita porque es lo unico que se puede SUMAR entre pasos:
 * un promedio no se suma, un total si.
 */
export interface PasoSalida {
  /** Ejecuciones que empezaron. */
  init: number;
  /** Ejecuciones que terminaron. `init - completed` = descartadas o reventadas. */
  completed: number;
  /** Ejecuciones medidas. Igual a `completed` salvo que algo no se instrumente. */
  n: number;
  /** Muestras detras de los percentiles. Menor que `n` = se alcanzo el techo. */
  muestras: number;
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
}

/**
 * @param cuenta las ejecuciones del tramo en la ventana. Va aparte del resumen
 *               porque un paso puede EMPEZAR sin dejar muestra (revento), y
 *               entonces no hay `Resumen` que lo cuente.
 */
export function presentarPaso(
  cuenta: { init: number; fin: number },
  r: Resumen | undefined,
  aproximado = false,
): PasoSalida | undefined {
  // Un percentil fundido tampoco es exacto: se declara igual que uno agregado.
  aproximado = aproximado || r?.fundido === true;
  // Un paso que ni empezo no aparece: en una corrida de 3.000 segundos, siete
  // pasos a cero por segundo son 21.000 lineas que dicen "aqui no paso nada".
  if (cuenta.init === 0 && (r === undefined || r.n === 0)) return undefined;
  return {
    init: cuenta.init,
    completed: cuenta.fin,
    n: r?.n ?? 0,
    muestras: r?.muestras ?? 0,
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
 * del orquestador.
 */
export function legible(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
