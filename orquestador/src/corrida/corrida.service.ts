import { Injectable, Logger } from '@nestjs/common';
import { ConfigService, idPrueba, rangoRitmo, validarPerfil } from '../config/config.service';
import type { Perfil, Tenant } from '../config/tipos';
import { BYTES_MAXIMO } from '../generador/payload';

/** Techo de sockets por destino, para que un `concurrency` enorme no los agote. */
const TOPE_CONEXIONES = 2048;

/**
 * La corrida activa.
 *
 * ────────────────────────────────────────────────────────────────────────
 * POR QUE EXISTE ESTA CLASE
 *
 * Antes el perfil se leia del YAML una vez al arrancar y nadie lo tocaba: el
 * contenedor hacia UNA corrida y se moria. Con `POST /corridas` el mismo
 * proceso tiene que atender muchas, cada una con su duracion, su destino y su
 * identificador — asi que el perfil deja de ser una constante del arranque y
 * pasa a ser estado de la corrida.
 *
 * El planificador y el emisor leen de aqui, no de ConfigService. Cuando no hay
 * corrida activa, esto devuelve el perfil del YAML tal cual, asi que el
 * comportamiento por defecto no cambia.
 * ────────────────────────────────────────────────────────────────────────
 */

export interface OpcionesCorrida {
  id?: string;
  /**
   * CUANTOS destinos, o cual: un numero son los N PRIMEROS tenants, 'all' son
   * todos, y un id literal ('tenant-07') es ese solo.
   *
   * Acepta numero y cadena — `40` y `"40"` son lo mismo — porque escribirlo a
   * mano de las dos formas es igual de natural.
   *
   * Ver `resolverTenants` al final del archivo: un numero era un INDICE y
   * ahora es una CANTIDAD.
   */
  client?: string | number;
  seconds?: number;
  /** Eventos/s POR TENANT. Excluyente con `request` y con `events`. */
  rate?: number;
  /**
   * Rangos de ritmo de ENVIO, en eventos por segundo.
   *
   *   { "client": { "min": 20, "max": 60 } }
   *
   * Cada segundo se sortea un ENTERO dentro del rango y ese es el numero
   * exacto de eventos que salen para ese cliente. La carga varia en vez de ser
   * plana — una carga plana no encuentra nada.
   *
   * ⚠ Gobierna el ENVIO, no la terminacion. El informe separa
   * `enviados_por_s` (lo que salio) de `aceptados_por_s` (lo que el destino
   * confirmo). Regular por terminacion seria omision coordinada.
   */
  request?: {
    client?: { min: number; max: number } | [number, number] | number;
  };
  /**
   * DOS SIGNIFICADOS, distinguidos por la forma. No es elegante, pero el campo
   * ya existia y romper los curls guardados de alguien es peor:
   *
   *   events: 2500                          TOTAL de eventos (modo smoke).
   *                                         Excluyente con `rate` y `request`.
   *
   *   events: { client: {min:1, max:10} }   DOCUMENTOS POR PETICION.
   *                                         COMPLEMENTA a `request`, no lo
   *                                         excluye: uno fija cuantas
   *                                         peticiones salen y el otro cuanto
   *                                         lleva cada una.
   */
  events?: number | { client?: { min: number; max: number } | [number, number] | number };
  perRequest?: number;
  concurrency?: number;
  /**
   * Conexiones HTTP simultaneas por destino.
   *
   * ⚠ Es un TECHO DURO de ritmo: `conexiones / latencia` req/s. Con 32
   * conexiones contra un destino de 0,8 s no pasaras de 40 req/s aunque pidas
   * 200 — el resto se descarta por saturacion.
   */
  connections?: number;
  timeout?: number;
  arrivals?: 'poisson' | 'uniforme';
  spread?: 'zipf' | 'uniforme';
  thread?: number;
  seed?: number;
  size?: [number, number];
  items?: [number, number];
  pool?: number;
  verify?: number;
}

export interface Corrida {
  id: string;
  perfil: Perfil;
  tenants: Tenant[];
  opciones: OpcionesCorrida;
  /** true si hay que reconstruir el pool antes de arrancar. */
  reconstruirPool: boolean;
  inicio: number | null;
}

@Injectable()
export class CorridaService {
  private readonly logger = new Logger(CorridaService.name);
  private _activa: Corrida | null = null;

  constructor(private readonly config: ConfigService) {}

  get activa(): Corrida | null { return this._activa; }

  /** El perfil vigente: el de la corrida si la hay, si no el del YAML. */
  get perfil(): Perfil { return this._activa?.perfil ?? this.config.perfil; }

  /** Los destinos vigentes: los de la corrida si la hay, si no todos. */
  get tenants(): Tenant[] { return this._activa?.tenants ?? this.config.tenants; }

  get pruebaId(): string {
    return this._activa?.id ?? this.config.perfil.envio.pruebaId ?? 'sin-id';
  }

  // -------------------------------------------------------------------------

  /**
   * Valida las opciones y construye el perfil de la corrida.
   *
   * No la activa: separar preparar de activar permite fallar con un 400 claro
   * ANTES de tocar el pool o las metricas. Una corrida que arranca y revienta
   * a mitad deja el proceso en un estado que hay que limpiar a mano.
   */
  preparar(o: OpcionesCorrida): Corrida {
    const base = this.config.perfil;

    const id = o.id === undefined || o.id === null
      ? sello()
      : idPrueba(o.id, 'id');

    const tenants = this.resolverTenants(o.client);

    const seconds = entero(o.seconds ?? 20, 'seconds', 1);
    const perRequest = entero(o.perRequest ?? base.envio.eventosPorRequest, 'perRequest', 1);
    // ────────────────────────────────────────────────────────────────────
    // SIN TOPE POR DEFECTO. 0 = sin limite.
    //
    // El tope de peticiones en vuelo es un LAZO CERRADO: frena el envio segun
    // lo rapido que conteste el destino. Eso es exactamente lo que O-02
    // prohibe — un destino lento recibiria menos carga y medirias un sistema
    // que se ve sano porque nadie lo esta presionando.
    //
    // Sin tope, el reloj manda: se envia la cuota entera pase lo que pase. Si
    // el destino no da abasto, el daño aparece donde debe — en la LATENCIA y
    // en los timeouts (`failed`) — y no como eventos que nunca salieron.
    //
    // Se deja poner un tope a mano como valvula de seguridad, pero es una
    // decision explicita y el informe la delata en `dropped_saturation`.
    // ────────────────────────────────────────────────────────────────────
    const concurrency = o.concurrency === undefined ? 0 : entero(o.concurrency, 'concurrency', 0);
    const timeout = entero(o.timeout ?? base.envio.timeoutMs, 'timeout', 1);
    // ────────────────────────────────────────────────────────────────────
    // `connections` SIGUE A `concurrency` por defecto.
    //
    // Tenerlos desacoplados era una contradiccion: permitir 256 peticiones en
    // vuelo con solo 32 conexiones significa que esas 256 NUNCA se alcanzan.
    // El techo real es `conexiones / latencia` req/s, y con 32 conexiones
    // contra un destino de 0,8 s son 40 req/s — pidieras lo que pidieras.
    //
    // El sintoma era cruel: el rango se respetaba (la cuota se ofrecia
    // entera) pero `sent` salia a un tercio, y el informe acusaba a la
    // saturacion del destino cuando el cuello era el propio emisor.
    //
    // Ahora el unico limitador es el que se pide. El tope de 2048 evita que
    // un `concurrency` enorme abra decenas de miles de sockets por destino.
    // ────────────────────────────────────────────────────────────────────
    const connections = o.connections === undefined
      ? (concurrency === 0 ? TOPE_CONEXIONES : Math.min(concurrency, TOPE_CONEXIONES))
      : entero(o.connections, 'connections', 1);
    const thread = entero(o.thread ?? base.pool.eventosPorHilo, 'thread', 1);

    const seed = o.seed === undefined ? base.pool.semilla : entero(o.seed, 'seed', 0);
    const size = o.size ?? base.pool.tamanoBytes;
    const items = o.items ?? base.pool.itemsPorDocumento;
    const plantillas = entero(o.pool ?? base.pool.plantillas, 'pool', 1);
    const verify = o.verify ?? base.pool.tasaVerificacion;

    // `events` numerico es un TOTAL y excluye a los otros dos. `events` como
    // objeto es el tamaño del lote y CONVIVE con ellos.
    const eventsEsTotal = typeof o.events === 'number';
    const eventsEsRango = o.events !== undefined && typeof o.events === 'object' && o.events !== null;

    const dados = [o.rate !== undefined && 'rate', eventsEsTotal && 'events',
                   o.request !== undefined && 'request'].filter(Boolean);
    if (dados.length > 1) {
      throw new Error(
        `${dados.join(' y ')} son excluyentes: 'rate' fija un ritmo plano, ` +
        `'request' fija rangos de peticiones/s, 'events' (numero) fija un total. ` +
        `Para el tamaño del lote usa 'events' como objeto: { client: { min, max } }.`,
      );
    }

    const rate = o.rate === undefined ? 40 : numero(o.rate, 'rate', 0);
    const events = eventsEsTotal ? entero(o.events, 'events', 1) : null;

    const porCliente = rangoRitmo(o.request?.client, 'request.client');
    const porPeticion = eventsEsRango
      ? rangoRitmo((o.events as { client?: unknown }).client, 'events.client')
      : null;

    // Se construye la forma YAML y se pasa por LOS MISMOS validadores que el
    // archivo. Un perfil que entra por HTTP no puede saltarse las
    // comprobaciones que sí hace el que entra por disco.
    const crudo = {
      modo: events !== null ? 'smoke' : 'carga',
      reparto: { tipo: o.spread ?? base.reparto.tipo, exponente: base.reparto.exponente },
      llegadas: { tipo: o.arrivals ?? base.llegadas.tipo, tick_ms: base.llegadas.tickMs },
      peticiones: { client: porCliente ?? undefined },
      eventos: { client: porPeticion ?? undefined },
      pool: {
        plantillas,
        semilla: seed,
        tamano_bytes: size,
        items_por_documento: items,
        eventos_por_hilo: thread,
        tasa_verificacion: verify,
      },
      envio: {
        ruta: base.envio.ruta,
        prueba_id: id,
        eventos_por_request: perRequest,
        espera_maxima_lote_ms: base.envio.esperaMaximaLoteMs,
        concurrencia_por_tenant: concurrency,
        timeout_ms: timeout,
        conexiones_por_destino: connections,
        reintentos: base.envio.reintentos,
      },
      smoke: events !== null
        ? { eventos_totales: events, llamadas_por_tenant: [10, 15], duracion_objetivo: `${seconds}s` }
        : { eventos_totales: 1, llamadas_por_tenant: [1, 1], duracion_objetivo: '1s' },
      carga: {
        // `rate` es POR TENANT y el perfil espera el ritmo agregado. Sin
        // multiplicar, pedir rate=40 con client=all repartiria 40 entre todos
        // en vez de dar 40 a cada uno.
        fases: [{
          nombre: 'corrida',
          duracion: `${seconds}s`,
          // Con `request` este numero no se usa: el planificador sortea el
          // ritmo cada segundo dentro de los rangos. Se deja coherente por si
          // alguien lee el perfil resuelto.
          ritmo: porCliente
            ? Math.max(1, Math.round(((porCliente.min + porCliente.max) / 2) * tenants.length))
            : Math.max(1, rate * tenants.length),
        }],
      },
    };

    const perfil = validarPerfil(crudo, 'POST /corridas');

    // El pool solo se reconstruye si de verdad cambio algo suyo: son 40 ms,
    // pero reconstruirlo sin motivo cambiaria el relleno de las plantillas
    // entre corridas que deberian ser identicas.
    const reconstruirPool =
      plantillas !== base.pool.plantillas ||
      seed !== base.pool.semilla ||
      size[0] !== base.pool.tamanoBytes[0] || size[1] !== base.pool.tamanoBytes[1] ||
      items[0] !== base.pool.itemsPorDocumento[0] || items[1] !== base.pool.itemsPorDocumento[1];

    return { id, perfil, tenants, opciones: o, reconstruirPool, inicio: null };
  }

  activar(c: Corrida): void {
    if (this._activa) throw new Error(`ya hay una corrida activa: ${this._activa.id}`);
    c.inicio = Date.now();
    this._activa = c;
    this.logger.log(
      `corrida '${c.id}' · ${c.tenants.length} destino(s) · ` +
      `${c.perfil.modo === 'smoke'
        ? c.perfil.smoke.eventosTotales + ' eventos'
        : c.perfil.carga.fases[0]!.ritmo + ' ev/s agregado'}`,
    );
  }

  desactivar(): void { this._activa = null; }

  // -------------------------------------------------------------------------

  private resolverTenants(client: unknown): Tenant[] {
    return resolverTenants(this.config.tenants, client);
  }
}

/**
 * A quien le pega una corrida.
 *
 * ⚠ UN NUMERO ES UNA CANTIDAD DE DESTINOS, NO UN INDICE.
 *
 *   `client: 40`  →  los 40 PRIMEROS tenants (tenant-01 … tenant-40)
 *   `client: 1`   →  solo tenant-01
 *   `"all"`       →  todos los que haya
 *   `"tenant-07"` →  ese y solo ese
 *
 * Antes el numero era un indice 1-based y `40` significaba "el tenant que hace
 * 40", uno solo. Se cambio porque la forma natural de pedir una prueba de
 * escala es "contra 40 clientes", y con la semantica vieja el numero de
 * destinos no se podia elegir sin volver a desplegar: o `"all"`, o uno.
 *
 * Y fallaba MUDO en la direccion peor. Pedias 40 y corrias contra 1, con un
 * informe que parecia bueno porque no habia fallado nada — solo que la carga
 * ofrecida era 1/40 de la que creias.
 *
 * `client: 1` da lo mismo con las dos semanticas, que es lo que permite el
 * cambio sin tocar los ejemplos ni `sh start`. Para apuntar a UN tenant que no
 * sea el primero esta el id literal, que ademas no depende del orden.
 *
 * Se exporta —en vez de quedarse privada— porque es la unica regla de la clase
 * que se puede equivocar en silencio, y probarla a traves del servicio exigiria
 * levantar la configuracion entera.
 */
export function resolverTenants(todos: readonly Tenant[], client: unknown): Tenant[] {
  if (todos.length === 0) throw new Error('config/tenants.yaml no tiene ningun tenant');

  if (client === undefined || client === null) return [...todos];

  // Se comprueba el TIPO antes de convertir. Sin esto, `Number(true)` da 1 y
  // `"client": true` acabaria corriendo contra el primer tenant en silencio
  // — una peticion mal formada produciendo una corrida que parece buena.
  if (typeof client !== 'string' && typeof client !== 'number') {
    throw new Error(
      `client debe ser texto o numero, vino ${typeof client} (${JSON.stringify(client)}). ` +
      `Vale "all", el id de un tenant, o CUANTOS destinos quieres.`,
    );
  }

  if (typeof client === 'string') {
    if (client === 'all') return [...todos];
    const porId = todos.find((t) => t.id === client);
    if (porId) return [porId];
    // Un id que no casa no cae al numero: `Number('tenant-07')` es NaN y el
    // error de abajo lo explica. Lo que NO puede pasar es que un id mal escrito
    // se resuelva a otra cosa.
  }

  const n = Number(client);

  // ⚠ PEDIR MAS DESTINOS DE LOS QUE HAY ES UN ERROR, NO UN RECORTE.
  //
  //   Si `client: 40` sobre 39 tenants devolviera los 39, el informe diria
  //   "40 clientes" y habrias medido 39. Un 2,5% que nadie ve a ojo y que
  //   invalida la comparacion entre corridas — justo el tipo de fallo que esta
  //   PoC existe para no tener.
  if (Number.isInteger(n) && n >= 1 && n <= todos.length) return todos.slice(0, n);

  throw new Error(
    `client '${client}' no vale. Hay ${todos.length} tenant(s): ` +
    `un numero de 1 a ${todos.length} son los N PRIMEROS destinos, ` +
    `"all" son los ${todos.length}, y un id literal (${todos[0]!.id}) es ese solo.`,
  );
}

// ---------------------------------------------------------------------------

function numero(v: unknown, campo: string, min: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min) {
    throw new Error(`'${campo}' debe ser un numero >= ${min}, vino ${JSON.stringify(v)}`);
  }
  return n;
}

function entero(v: unknown, campo: string, min: number): number {
  const n = numero(v, campo, min);
  if (!Number.isInteger(n)) throw new Error(`'${campo}' debe ser entero, vino ${n}`);
  return n;
}

/** Identificador por defecto. Una corrida sin identificar se mezcla con otra. */
function sello(): string {
  const t = new Date();
  const dd = (n: number) => String(n).padStart(2, '0');
  return `corrida-${t.getFullYear()}${dd(t.getMonth() + 1)}${dd(t.getDate())}` +
         `-${dd(t.getHours())}${dd(t.getMinutes())}${dd(t.getSeconds())}`;
}

export { BYTES_MAXIMO };
