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
 * Ritmo de ENVIO, en PETICIONES HTTP por segundo.
 *
 * ⚠ CUENTA PETICIONES, NO EVENTOS. Cuantos documentos lleva cada peticion lo
 * decide `eventos` (abajo). Los dos juntos dan el ritmo de eventos:
 *
 *   eventos/s = peticiones/s x documentos por peticion
 *
 * Antes este rango contaba eventos y el tamaño del lote era fijo
 * (`eventos_por_request`). Con `eventos_por_request = 1` los dos numeros
 * coincidian y la diferencia no se notaba — pero en cuanto una peticion lleva
 * mas de un documento son cosas distintas, y el informe tiene que poder
 * separarlas para responder si el limite es por peticion o por evento.
 *
 * ⚠ Y gobierna el momento en que la peticion SALE, no cuando el destino
 * contesta. Son dos metricas distintas y el informe las separa:
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
   * Rango de PETICIONES por cliente y por segundo. Cada segundo se sortea un
   * entero dentro del rango, y ESE es el numero exacto de peticiones que sale.
   *
   * null = sin rango: manda el ritmo de la fase repartido por los pesos.
   */
  porCliente: Rango | null;
}

/**
 * Cuantos DOCUMENTOS van dentro de cada peticion.
 *
 * Se sortea uno por peticion, no uno por segundo: dos peticiones del mismo
 * segundo pueden llevar 3 y 9 documentos. Un tamaño de lote fijo es trafico de
 * laboratorio; en produccion los lotes varian y el destino tiene que
 * aguantarlo.
 *
 * ⚠ El tamaño lo decide el PLAN, no un buffer que se llena. Antes los eventos
 * se acumulaban hasta juntar `eventos_por_request` y se soltaban; eso hacia
 * que el instante de salida dependiera del ritmo, y un tenant lento metia
 * latencia de arnes disfrazada de latencia del sistema. Ahora cada peticion
 * tiene su instante y su tamaño decididos antes de que empiece la corrida.
 */
export interface EventosPorPeticion {
  /**
   * Rango de documentos por peticion. null = tamaño fijo, el de
   * `envio.eventos_por_request`.
   */
  porPeticion: Rango | null;
}

export interface Perfil {
  modo: Modo;
  smoke: PerfilSmoke;
  carga: PerfilCarga;
  reparto: Reparto;
  llegadas: Llegadas;
  peticiones: Peticiones;
  /** Cuantos documentos van dentro de cada peticion. */
  eventos: EventosPorPeticion;
  pool: Pool;
  envio: Envio;
}
