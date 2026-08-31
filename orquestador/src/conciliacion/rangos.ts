/**
 * Rangos de `sequence`, inclusivos por los dos extremos.
 *
 * ────────────────────────────────────────────────────────────────────────
 * POR QUE RANGOS Y NO LA LISTA DENSA
 *
 * Las secuencias de un expediente son consecutivas por construccion: el
 * planificador reparte 1..N y solo se rompe la racha cuando algo no salio.
 * Guardar `[1,2,3,4,5,6,7,8,9,10]` en vez de `[[1,10]]` multiplica por diez un
 * archivo que en el perfil grande ya tiene millones de entradas, y no añade un
 * solo dato: lo interesante es justo donde la racha SE ROMPE.
 *
 * Y hay una segunda razon, menos obvia: comparar dos listas densas de 25
 * millones de enteros obliga a materializarlas en memoria. Restando rangos, la
 * conciliacion recorre estructuras del tamaño del numero de huecos, que en una
 * corrida sana es cero.
 * ────────────────────────────────────────────────────────────────────────
 */

/** `[desde, hasta]`, ambos incluidos. `[3,3]` es un solo valor. */
export type Rango = [number, number];

/**
 * Comprime una coleccion de enteros a rangos.
 *
 * Ordena y deduplica: los eventos se registran en el orden en que salen por el
 * cable, y con lotes concurrentes ese orden no es el logico.
 */
export function aRangos(nums: Iterable<number>): Rango[] {
  const ordenados = [...new Set(nums)].sort((a, b) => a - b);
  const salida: Rango[] = [];

  for (const n of ordenados) {
    const ultimo = salida[salida.length - 1];
    if (ultimo && n === ultimo[1] + 1) ultimo[1] = n;
    else salida.push([n, n]);
  }
  return salida;
}

/** Cuantos valores cubren los rangos. No expande: suma anchuras. */
export function contar(rs: readonly Rango[]): number {
  let n = 0;
  for (const [a, b] of rs) n += b - a + 1;
  return n;
}

export function primero(rs: readonly Rango[]): number | null {
  return rs.length === 0 ? null : rs[0]![0];
}

export function ultimo(rs: readonly Rango[]): number | null {
  return rs.length === 0 ? null : rs[rs.length - 1]![1];
}

/**
 * `a` menos `b`: lo que esta en `a` y no en `b`.
 *
 * Es la operacion que responde P4 — «esto salio, esto llego, esto falta» — y
 * la unica de este archivo con logica de verdad. Se asume que las dos entradas
 * estan normalizadas (ordenadas y sin solapes), que es lo que devuelve
 * `aRangos`.
 */
export function restar(a: readonly Rango[], b: readonly Rango[]): Rango[] {
  const salida: Rango[] = [];
  let j = 0;

  for (const [ini, fin] of a) {
    let desde = ini;

    // Se avanza `b` hasta el primer rango que pueda tocar a este.
    while (j < b.length && b[j]![1] < desde) j++;

    let k = j;
    while (k < b.length && b[k]![0] <= fin) {
      const [bi, bf] = b[k]!;
      if (bi > desde) salida.push([desde, Math.min(bi - 1, fin)]);
      desde = Math.max(desde, bf + 1);
      if (desde > fin) break;
      k++;
    }

    if (desde <= fin) salida.push([desde, fin]);
  }

  return salida;
}

/**
 * Expande a valores sueltos con un tope, y declara cuantos se quedaron fuera.
 *
 * El tope no es una optimizacion: un expediente con diez mil huecos volcaria
 * diez mil enteros al informe y lo haria ilegible. Pero un recorte que no se
 * declara se lee como «solo faltaban tres», que es peor que no informar.
 */
export function expandir(rs: readonly Rango[], tope: number): { valores: number[]; truncado: number } {
  const valores: number[] = [];
  let truncado = 0;

  for (const [a, b] of rs) {
    for (let n = a; n <= b; n++) {
      if (valores.length >= tope) { truncado += b - n + 1; break; }
      valores.push(n);
    }
  }
  return { valores, truncado };
}
