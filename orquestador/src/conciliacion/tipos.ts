/**
 * Las tres formas que viajan entre los dos lados de la conciliacion.
 *
 *   Manifiesto    lo escribe el orquestador  → que expedientes SALIERON
 *   VolcadoInbox  lo escribe C4              → que expedientes LLEGARON
 *   Veredicto     lo escribe el conciliador  → que falta, y de quien es
 *
 * Viven en un archivo aparte a proposito: el conciliador es un CLI que corre
 * mucho despues de la corrida, contra dos archivos JSON, sin levantar Nest ni
 * tocar la base. Si estas formas colgaran del servicio que las produce, cruzar
 * dos corridas viejas obligaria a arrancar el arnes entero.
 */
import type { Rango } from './rangos';

export type { Rango };

// ── Lo que sale ─────────────────────────────────────────────────────────

export interface ExpedienteManifiesto {
  rpf_id: string;
  tenant: string;
  /** Entro en el cuerpo de una peticion HTTP. */
  emitidos: Rango[];
  /** El destino contesto 2xx. Es lo unico que se le puede exigir a C3. */
  aceptados: Rango[];
  /** El destino contesto, pero != 2xx. */
  rechazados: Rango[];
  /** Timeout o error de red: no hubo respuesta. */
  fallidos: Rango[];
  /** Se planifico y nunca salio: atraso del arnes o tope en vuelo. */
  no_emitidos: Rango[];
}

export interface Manifiesto {
  prueba: string;
  generado: string;
  /** true si se alcanzo el tope de expedientes y hay datos fuera. */
  truncado: boolean;
  expedientes_omitidos: number;
  totales: {
    expedientes: number;
    emitidos: number;
    aceptados: number;
    rechazados: number;
    fallidos: number;
    /** Emitidos sin resolucion: salieron y nadie contesto todavia. */
    en_vuelo: number;
    no_emitidos_retraso: number;
    no_emitidos_saturacion: number;
  };
  expedientes: ExpedienteManifiesto[];
}

// ── Lo que llega ────────────────────────────────────────────────────────

export interface VolcadoInbox {
  generado: string;
  esquema: string;
  /**
   * El id de corrida por el que se filtro (`inbox.prueba`), o null.
   *
   * Es el corte EXACTO: el mismo id que este manifiesto lleva en `prueba`. Si
   * los dos estan puestos y no coinciden, se estan cruzando dos corridas
   * distintas y el resultado no significa nada.
   */
  prueba?: string | null;
  /** Corte temporal sobre `e7_recibido`, o null. Aproximado; ver `prueba`. */
  desde: string | null;
  totales: {
    inbox: number;
    duplicados: number;
    expedientes: number;
    descartes: number;
  };
  expedientes: Array<{
    rpf_id: string;
    sequences: Rango[];
    duplicados: number;
  }>;
}

// ── El cruce ────────────────────────────────────────────────────────────

/** Donde falta, respecto de lo que si llego. */
export type Forma = 'hueco_interior' | 'cabeza' | 'cola' | 'ausente';

/** De quien es la ausencia. */
export type Culpa = 'perdida' | 'sin_confirmar' | 'mixto';

export interface Falta {
  rpf_id: string;
  tenant: string;
  faltan: Rango[];
  cuantos: number;
  forma: Forma;
  clasificacion: Culpa;
}

export interface Veredicto {
  prueba: string;
  generado: string;
  /**
   * false si hay una sola perdida real o el manifiesto venia incompleto.
   *
   * Los duplicados NO lo tumban: la entrega es al-menos-una-vez y un duplicado
   * es funcionamiento normal (regla 4).
   */
  ok: boolean;
  avisos: string[];
  totales: {
    expedientes_manifiesto: number;
    expedientes_inbox: number;
    emitidos: number;
    aceptados: number;
    no_emitidos: number;
    llegados: number;
    duplicados: number;
    faltan: number;
    desconocidos: number;
  };
  /** Los que faltan, por culpable. */
  clasificacion: {
    /** Aceptado por el destino y ausente en C4. Es el defecto. */
    perdida: number;
    /** Emitido sin confirmacion 2xx: no se puede exigir. */
    sin_confirmar: number;
    /** Nunca salio del arnes. No es un hueco. */
    arnes: number;
  };
  /** Cuantos expedientes, por la forma de la ausencia. */
  orden: {
    expedientes_con_hueco_interior: number;
    expedientes_truncados: number;
    expedientes_ausentes: number;
  };
  detalle: Falta[];
  detalle_omitido: number;
  /** En C4 y no en el manifiesto: otra corrida, o algo que nadie emitio. */
  desconocidos: string[];
}
