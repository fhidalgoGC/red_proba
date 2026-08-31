/**
 * Retardo artificial de la respuesta, en milisegundos. `C3_DELAY_MS=300`.
 *
 * Es una perilla de PRUEBA, no del producto. Existe porque C3 en local
 * contesta en ~2 ms y a esa velocidad casi todo se completa en el mismo
 * segundo en que se envio — lo que hace imposible comprobar que el orquestador
 * separa de verdad `sent` de `completed`. Con un retardo se ve el desfase, que
 * es lo que va a pasar de verdad cuando C3 firme con KMS.
 *
 * Acepta un rango: `C3_DELAY_MS=100-500` sortea uno por peticion.
 *
 * Vive en su propio archivo porque lo leen dos controladores: el que lo APLICA
 * (`POST /events`) y el que lo DECLARA (`GET /health`). Que el health lo diga
 * importa — una latencia de 800 ms que sale de una variable de entorno y no de
 * la arquitectura tiene que ser visible, o alguien la medira y la reportara.
 */
export const RETARDO = (() => {
  const v = process.env.C3_DELAY_MS;
  if (!v) return null;
  const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(v.trim());
  if (!m) return null;
  const min = Number(m[1]);
  const max = m[2] === undefined ? min : Number(m[2]);
  return max >= min ? { min, max } : null;
})();

export const dormir = (ms: number): Promise<unknown> =>
  new Promise((r) => setTimeout(r, ms));
