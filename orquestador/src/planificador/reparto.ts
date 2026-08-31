import type { Reparto, Tenant } from '../config/tipos';

/**
 * O-03 — Reparto del ritmo agregado entre los tenants.
 *
 * Repartir 2.000 eventos/s entre 50 tenants a 40 cada uno es lo que NUNCA
 * pasa en produccion. El trafico multi-tenant real sigue una ley de potencias:
 * unos pocos clientes generan la mayoria del volumen.
 *
 * Con Zipf y 50 tenants, el mas grande se lleva ~445 eventos/s y la cola larga
 * ~9. Eso ejercita cosas que el reparto uniforme esconde — en particular el
 * techo de 300 mensajes/s por MessageGroupId (D-06), que con reparto parejo
 * simplemente no se alcanza.
 *
 * Devuelve pesos NORMALIZADOS: suman 1. El ritmo de cada tenant es
 * `ritmoAgregado * peso`.
 */
export function calcularPesos(tenants: Tenant[], reparto: Reparto): number[] {
  const n = tenants.length;
  if (n === 0) return [];

  // Peso explicito en tenants.yaml gana sobre la distribucion del perfil.
  // Sirve para forzar un escenario concreto (p.ej. un solo tenant caliente).
  const explicitos = tenants.filter((t) => t.peso !== null);
  if (explicitos.length > 0) {
    if (explicitos.length !== n) {
      throw new Error(
        'reparto: o todos los tenants declaran `peso`, o ninguno. ' +
        `Declaran ${explicitos.length} de ${n}.`,
      );
    }
    return normalizar(tenants.map((t) => t.peso!));
  }

  if (reparto.tipo === 'uniforme') {
    return new Array(n).fill(1 / n);
  }

  // Zipf: el peso del rango i (1-indexado) es 1/i^s.
  const crudos = new Array<number>(n);
  for (let i = 0; i < n; i++) crudos[i] = 1 / Math.pow(i + 1, reparto.exponente);
  return normalizar(crudos);
}

function normalizar(pesos: number[]): number[] {
  const total = pesos.reduce((a, b) => a + b, 0);
  if (!(total > 0)) throw new Error('reparto: los pesos suman 0');
  return pesos.map((p) => p / total);
}

/**
 * Reparte un entero N entre pesos que suman 1, sin perder ni inventar
 * unidades. Metodo del resto mayor: si repartieras con Math.round por
 * separado, la suma no daria N y el total de la corrida no coincidiria con
 * `eventos_totales` — que es justo el numero contra el que se concilia P4.
 */
export function repartirEntero(total: number, pesos: number[]): number[] {
  const exactos = pesos.map((p) => total * p);
  const base = exactos.map((x) => Math.floor(x));
  let asignado = base.reduce((a, b) => a + b, 0);

  const restos = exactos
    .map((x, i) => ({ i, resto: x - Math.floor(x) }))
    .sort((a, b) => b.resto - a.resto);

  let k = 0;
  while (asignado < total && restos.length > 0) {
    base[restos[k % restos.length]!.i]!++;
    asignado++;
    k++;
  }
  return base;
}
