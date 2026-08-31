/**
 * Rangos de `sequence`, inclusivos por los dos extremos.
 *
 * ⚠ EL FORMATO ES EL MISMO QUE `orquestador/src/conciliacion/rangos.ts`, y por
 * una razon concreta: el conciliador RESTA los rangos de este volcado a los
 * del manifiesto. Si las dos copias comprimieran distinto, la resta daria
 * huecos donde no los hay — y un hueco inventado es exactamente el hallazgo
 * que nadie quiere ver en la unica metrica que afirma que el orden se mantuvo.
 *
 * Aqui solo vive la compresion; la resta y el veredicto son del orquestador,
 * que es quien sabe lo que se emitio. C4 nunca puede afirmar que falta algo:
 * solo puede decir que tiene.
 */

/** `[desde, hasta]`, ambos incluidos. */
export type Rango = [number, number];

/** Comprime enteros a rangos. Ordena y deduplica antes. */
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
