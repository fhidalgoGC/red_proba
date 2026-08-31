/**
 * O-04 — Llegadas de Poisson.
 *
 * 40 eventos/s repartidos exactamente cada 25 ms es trafico de laboratorio.
 * El real llega en rafagas. Un proceso de Poisson tiene intervalos
 * EXPONENCIALES: misma media, distribucion muy distinta, y son las rafagas
 * las que llenan el outbox y disparan el throttling de KMS.
 */

/**
 * Intervalo hasta la siguiente llegada, en milisegundos.
 *
 * @param ritmo  eventos por segundo (lambda)
 * @param u      uniforme en [0,1) del PRNG
 */
export function intervaloPoissonMs(ritmo: number, u: number): number {
  if (ritmo <= 0) return Number.POSITIVE_INFINITY;
  // -ln(U)/lambda. Se descarta u=0 para no producir Infinity: se remapea al
  // menor positivo representable, que da el intervalo mas largo posible.
  const x = u > 0 ? u : Number.MIN_VALUE;
  return (-Math.log(x) / ritmo) * 1000;
}

/** Intervalo determinista: 1/lambda. Trafico plano, para contrastar. */
export function intervaloUniformeMs(ritmo: number): number {
  if (ritmo <= 0) return Number.POSITIVE_INFINITY;
  return 1000 / ritmo;
}
