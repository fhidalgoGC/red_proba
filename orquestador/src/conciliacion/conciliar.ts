/**
 * O-09 · El cruce que responde P4.
 *
 * ────────────────────────────────────────────────────────────────────────
 * QUE APORTA SOBRE LA CONSULTA DE HUECOS DE C4 (G-05)
 *
 * La consulta de C4 agrupa el inbox por `rpf_id` y compara el rango que ve
 * contra los valores distintos que hay dentro. Solo encuentra huecos
 * INTERIORES, porque el rango lo definen los propios datos que llegaron:
 *
 *   falta el 5 de 1..10   →  lo ve      (el rango sigue siendo 1..10)
 *   falta el 1            →  no lo ve   (MIN pasa a 2 y 2..10 es denso)
 *   faltan el 9 y el 10   →  no lo ve   (MAX pasa a 8 y 1..8 es denso)
 *   falta el expediente   →  no lo ve   (no hay ni fila que agrupar)
 *
 * Y el fallo mas probable de esta PoC —un relay que se detiene con filas
 * todavia pendientes en su outbox— se lleva justo la cola. El manifiesto trae el rango
 * emitido desde FUERA de C4, y con eso los tres puntos ciegos se cierran.
 *
 * ⚠ LA TRAMPA QUE ESTE ARCHIVO TIENE QUE EVITAR: no todo lo que falta es una
 * perdida. Un evento que el arnes planifico y nunca disparo deja un hueco en
 * el espacio de secuencias que NO es un hueco del sistema. Contarlo como tal
 * acusaria a C3 de perder eventos que jamas existieron, y P4 daria un falso
 * negativo justo en la metrica que afirma que el orden se mantuvo.
 * ────────────────────────────────────────────────────────────────────────
 */
import { contar, primero, restar, ultimo, type Rango } from './rangos';
import type { Falta, Forma, Manifiesto, Veredicto, VolcadoInbox } from './tipos';

export interface OpcionesConciliacion {
  /** Cuantas faltas se detallan. El resto se cuenta y se declara. */
  topeDetalle?: number;
}

const TOPE_DETALLE = 500;

/** Severidad para ordenar el detalle: lo que hay que mirar primero, primero. */
const PESO: Record<Forma, number> = {
  hueco_interior: 0,   // invalida la afirmacion de orden
  ausente: 1,          // se perdio un expediente entero
  cola: 2,             // el sintoma tipico de una tarea que murio
  cabeza: 3,
};

export function conciliar(
  m: Manifiesto,
  i: VolcadoInbox,
  opciones: OpcionesConciliacion = {},
): Veredicto {
  const topeDetalle = opciones.topeDetalle ?? TOPE_DETALLE;

  const porRpf = new Map(i.expedientes.map((e) => [e.rpf_id, e]));
  const vistos = new Set<string>();

  const faltas: Falta[] = [];
  let perdida = 0;
  let sinConfirmar = 0;
  let arnes = 0;
  let llegados = 0;
  let duplicados = 0;
  let emitidos = 0;
  let aceptados = 0;
  const orden = {
    expedientes_con_hueco_interior: 0,
    expedientes_truncados: 0,
    expedientes_ausentes: 0,
  };

  for (const e of m.expedientes) {
    const enC4 = porRpf.get(e.rpf_id);
    if (enC4) vistos.add(e.rpf_id);
    const llegadas: Rango[] = enC4?.sequences ?? [];

    emitidos += contar(e.emitidos);
    aceptados += contar(e.aceptados);
    arnes += contar(e.no_emitidos);
    llegados += contar(llegadas);
    // Los duplicados se suman SOLO de los expedientes que el manifiesto
    // reconoce: los de C4 incluyen los de otras corridas que quedaron en la
    // misma base, y ese numero no es de esta prueba.
    duplicados += enC4?.duplicados ?? 0;

    // Lo exigible es lo que el destino CONFIRMO con 2xx. Lo demas salio, pero
    // nadie dijo que hubiera entrado.
    const faltaExigible = restar(e.aceptados, llegadas);
    const faltaSinConfirmar = restar(restar(e.emitidos, e.aceptados), llegadas);

    perdida += contar(faltaExigible);
    sinConfirmar += contar(faltaSinConfirmar);

    const todas = unir(faltaExigible, faltaSinConfirmar);
    if (todas.length === 0) continue;

    const forma = formaDe(todas, llegadas);

    // ────────────────────────────────────────────────────────────────────
    // LOS CONTADORES DE `orden` SOLO MIRAN LO EXIGIBLE.
    //
    // Un expediente al que le falta el 5 porque la peticion que lo llevaba
    // volvio 503 tiene un hueco en el espacio de secuencias, pero eso NO
    // invalida la afirmacion de orden: ese evento nunca entro en el sistema.
    // Contarlo aqui haria que la metrica mas grave de la prueba se disparara
    // por rechazos del destino, que es justo lo que el desglose de O-06
    // existe para separar. El hueco se sigue viendo en `detalle`, con su
    // clasificacion; lo que no hace es acusar al orden.
    // ────────────────────────────────────────────────────────────────────
    if (faltaExigible.length > 0) {
      const formaExigible = formaDe(faltaExigible, llegadas);
      if (formaExigible === 'hueco_interior') orden.expedientes_con_hueco_interior++;
      else if (formaExigible === 'ausente') orden.expedientes_ausentes++;
      else if (formaExigible === 'cola') orden.expedientes_truncados++;
    }

    faltas.push({
      rpf_id: e.rpf_id,
      tenant: e.tenant,
      faltan: todas,
      cuantos: contar(todas),
      forma,
      clasificacion:
        faltaExigible.length > 0 && faltaSinConfirmar.length > 0 ? 'mixto'
        : faltaExigible.length > 0 ? 'perdida'
        : 'sin_confirmar',
    });
  }

  const desconocidos = i.expedientes.filter((e) => !vistos.has(e.rpf_id)).map((e) => e.rpf_id);

  faltas.sort((a, b) => PESO[a.forma] - PESO[b.forma] || b.cuantos - a.cuantos);

  const avisos: string[] = [];
  if (m.truncado) {
    avisos.push(
      `el manifiesto esta truncado: ${m.expedientes_omitidos} expediente(s) fuera. ` +
      `El veredicto no cubre la corrida entera.`,
    );
  }
  if (m.totales.en_vuelo > 0) {
    avisos.push(
      `${m.totales.en_vuelo} evento(s) quedaron en vuelo al cerrar el manifiesto: ` +
      `salieron y nadie contesto. Cuentan como sin_confirmar, no como perdida.`,
    );
  }
  if (desconocidos.length > 0) {
    avisos.push(
      `${desconocidos.length} expediente(s) del inbox no estan en el manifiesto` +
      (i.desde === null
        ? '. El volcado de C4 no llevaba corte temporal: lo mas probable es que sean de otra corrida.'
        : '. Con corte temporal aplicado, esto no deberia pasar.'),
    );
  }
  if (perdida > 0) {
    avisos.push(`${perdida} evento(s) aceptados por el destino no estan en C4. Eso es perdida.`);
  }

  return {
    prueba: m.prueba,
    generado: new Date().toISOString(),
    // Los duplicados NO tumban el veredicto: la entrega es al-menos-una-vez y
    // un duplicado es funcionamiento normal (regla 4).
    ok: perdida === 0 && !m.truncado,
    avisos,
    totales: {
      expedientes_manifiesto: m.expedientes.length,
      expedientes_inbox: i.expedientes.length,
      emitidos,
      aceptados,
      no_emitidos: arnes,
      llegados,
      duplicados,
      faltan: perdida + sinConfirmar,
      desconocidos: desconocidos.length,
    },
    clasificacion: { perdida, sin_confirmar: sinConfirmar, arnes },
    orden,
    detalle: faltas.slice(0, topeDetalle),
    detalle_omitido: Math.max(0, faltas.length - topeDetalle),
    desconocidos,
  };
}

// ---------------------------------------------------------------------------

/**
 * Donde falta, respecto de lo que si llego.
 *
 * La distincion importa porque acusa a cosas distintas: un hueco INTERIOR con
 * FIFO no deberia poder existir y es el hallazgo grave; una COLA que falta es
 * el sintoma de una tarea que murio con su outbox dentro, que es un limite ya
 * declarado de la PoC.
 */
function formaDe(faltan: readonly Rango[], llegadas: readonly Rango[]): Forma {
  if (llegadas.length === 0) return 'ausente';

  const min = primero(llegadas)!;
  const max = ultimo(llegadas)!;

  if (ultimo(faltan)! < min) return 'cabeza';
  if (primero(faltan)! > max) return 'cola';
  return 'hueco_interior';
}

/** Union de dos conjuntos de rangos ya normalizados. */
function unir(a: readonly Rango[], b: readonly Rango[]): Rango[] {
  if (a.length === 0) return [...b];
  if (b.length === 0) return [...a];

  const todos = [...a, ...b].sort((x, y) => x[0] - y[0]);
  const salida: Rango[] = [];

  for (const [ini, fin] of todos) {
    const u = salida[salida.length - 1];
    if (u && ini <= u[1] + 1) u[1] = Math.max(u[1], fin);
    else salida.push([ini, fin]);
  }
  return salida;
}
