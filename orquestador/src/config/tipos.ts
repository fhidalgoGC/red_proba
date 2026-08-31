/** Formas ya validadas de config/tenants.yaml y config/perfil.yaml. */

export interface Tenant {
  id: string;
  url: string;
  /** Peso explicito para el reparto. Si es null, manda `reparto` del perfil. */
  peso: number | null;
}

export interface Fase {
  nombre: string;
  /** Duracion en milisegundos. */
  duracionMs: number;
  /** Ritmo objetivo en eventos/segundo, agregado entre TODOS los tenants. */
  ritmo: number;
}

export type Modo = 'smoke' | 'carga';

export interface PerfilSmoke {
  eventosTotales: number;
  llamadasPorTenant: [number, number];
  duracionObjetivoMs: number;
}

export interface PerfilCarga {
  fases: Fase[];
}

export interface Reparto {
  tipo: 'zipf' | 'uniforme';
  exponente: number;
}

export interface Llegadas {
  tipo: 'poisson' | 'uniforme';
  tickMs: number;
}

export interface Pool {
  plantillas: number;
  semilla: number;
  /** Rango [min, max] de tamaño canonico en bytes. min === max => tamaño fijo. */
  tamanoBytes: [number, number];
  /** Rango [min, max] de items por documento. Se recorta si no entra en el target. */
  itemsPorDocumento: [number, number];
  eventosPorHilo: number;
  tasaVerificacion: number;
}

export interface Envio {
  ruta: string;
  /**
   * Identificador de la corrida. Viaja en la cabecera `x-prueba-id` de cada
   * request para que C3 pueda agrupar por prueba en sus logs.
   *
   * En CABECERA y no dentro del documento: el payload se firma, y meterle
   * metadatos de la prueba cambiaria lo que se firma. Es la misma regla que
   * mantiene las marcas de tiempo fuera del payload.
   */
  pruebaId: string | null;
  eventosPorRequest: number;
  esperaMaximaLoteMs: number;
  concurrenciaPorTenant: number;
  timeoutMs: number;
  conexionesPorDestino: number;
  reintentos: number;
}

/** Un rango cerrado [min, max]. */
export interface Rango { min: number; max: number }

/**
 * Ritmo de ENVIO, en eventos por segundo.
 *
 * ⚠ Esto gobierna el momento en que el evento SALE, no el momento en que el
 * destino contesta. Son dos metricas distintas y el informe las separa:
 *
 *   enviados_por_s    lo que salio al cable ese segundo   (envio)
 *   aceptados_por_s   lo que el destino confirmo ese segundo (terminacion)
 *
 * Un sistema que se atasca sigue recibiendo el ritmo de envio pactado y su
 * ritmo de terminacion se hunde. Si el arnes regulara por terminacion en vez
 * de por envio, dejaria de presionar justo cuando empieza lo interesante —
 * es la omision coordinada de O-02, por la puerta de atras.
 */
export interface Peticiones {
  /**
   * Rango de eventos por cliente y por segundo. Cada segundo se sortea un
   * entero dentro del rango, y ESE es el numero exacto que sale.
   *
   * null = sin rango: manda el ritmo de la fase repartido por los pesos.
   */
  porCliente: Rango | null;
}

export interface Perfil {
  modo: Modo;
  smoke: PerfilSmoke;
  carga: PerfilCarga;
  reparto: Reparto;
  llegadas: Llegadas;
  peticiones: Peticiones;
  pool: Pool;
  envio: Envio;
}
