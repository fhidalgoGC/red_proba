import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { BYTES_MAXIMO, BYTES_MINIMO_VIABLE, RESERVA_RELLENO } from '../generador/payload';
import type { Envio, EventosPorPeticion, Fase, Llegadas, Modo, Peticiones, Perfil, PerfilCarga, PerfilSmoke, Pool, Rango, Reparto, Tenant } from './tipos';

/**
 * Carga y valida los dos archivos de configuracion.
 *
 * O-01: la forma de la prueba es DATOS, no codigo. Cambiar el perfil no debe
 * requerir compilar ni desplegar.
 *
 * La validacion es estricta y explota al arrancar. Un orquestador que arranca
 * con un perfil a medias produce una corrida cuyos numeros no se pueden
 * defender, y eso es peor que no arrancar.
 */
@Injectable()
export class ConfigService implements OnModuleInit {
  private readonly logger = new Logger(ConfigService.name);

  private _tenants!: Tenant[];
  private _perfil!: Perfil;

  onModuleInit(): void {
    // El CLI de `burst` inyecta perfil y destinos por entorno en vez de por
    // archivo. Pasan por LOS MISMOS validadores que el YAML: una corrida de
    // prueba tiene que ejercitar el mismo camino de codigo que la de verdad,
    // o no esta probando lo que crees.
    const inyectado = process.env.ORQ_PERFIL_JSON;
    if (inyectado) {
      this._tenants = validarTenants(JSON.parse(process.env.ORQ_TENANTS_JSON ?? '{}'), 'ORQ_TENANTS_JSON');
      this._perfil = validarPerfil(JSON.parse(inyectado), 'ORQ_PERFIL_JSON');
      this.logger.log(
        `config inyectada: ${this._tenants.length} tenant(s), modo=${this._perfil.modo}`,
      );
      return;
    }

    const dir = process.env.ORQ_CONFIG_DIR ?? join(process.cwd(), 'config');

    this._tenants = leerTenants(join(dir, 'tenants.yaml'));
    this._perfil = leerPerfil(join(dir, 'perfil.yaml'));

    this.logger.log(
      `config: ${this._tenants.length} tenants, modo=${this._perfil.modo}, ` +
      `reparto=${this._perfil.reparto.tipo}, llegadas=${this._perfil.llegadas.tipo}`,
    );
  }

  get tenants(): Tenant[] { return this._tenants; }
  get perfil(): Perfil { return this._perfil; }
}

// ---------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------

function leerYaml(ruta: string): unknown {
  let texto: string;
  try {
    texto = readFileSync(ruta, 'utf8');
  } catch (e) {
    throw new Error(`no se pudo leer ${ruta}: ${(e as Error).message}`);
  }
  return parseYaml(texto);
}

export function leerTenants(ruta: string): Tenant[] {
  return validarTenants(leerYaml(ruta), ruta);
}

export function validarTenants(doc: unknown, ruta: string): Tenant[] {
  const lista = (doc as { tenants?: unknown })?.tenants;

  if (!Array.isArray(lista) || lista.length === 0) {
    throw new Error(`${ruta}: se esperaba una lista 'tenants' no vacia`);
  }

  const vistos = new Set<string>();
  return lista.map((t: any, i: number): Tenant => {
    if (typeof t?.id !== 'string' || !t.id) {
      throw new Error(`${ruta}: tenants[${i}].id ausente o no es string`);
    }
    if (typeof t?.url !== 'string' || !/^https?:\/\//.test(t.url)) {
      throw new Error(`${ruta}: tenants[${i}].url debe ser http(s)://…`);
    }
    if (vistos.has(t.id)) {
      // Un id duplicado partiria el reparto y la conciliacion de P4 en dos.
      throw new Error(`${ruta}: id de tenant duplicado '${t.id}'`);
    }
    vistos.add(t.id);

    const peso = t.peso === undefined || t.peso === null ? null : num(t.peso, `${ruta}: tenants[${i}].peso`);
    if (peso !== null && peso <= 0) {
      throw new Error(`${ruta}: tenants[${i}].peso debe ser > 0`);
    }

    return { id: t.id, url: t.url.replace(/\/+$/, ''), peso };
  });
}

export function leerPerfil(ruta: string): Perfil {
  return validarPerfil(leerYaml(ruta), ruta);
}

export function validarPerfil(doc: unknown, ruta: string): Perfil {
  const d = doc as any;
  if (!d || typeof d !== 'object') throw new Error(`${ruta}: vacio o mal formado`);

  const modo = d.modo as Modo;
  if (modo !== 'smoke' && modo !== 'carga') {
    throw new Error(`${ruta}: modo debe ser 'smoke' o 'carga', vino '${d.modo}'`);
  }

  const smoke: PerfilSmoke = {
    eventosTotales: entero(d.smoke?.eventos_totales, `${ruta}: smoke.eventos_totales`, 1),
    llamadasPorTenant: rango(d.smoke?.llamadas_por_tenant, `${ruta}: smoke.llamadas_por_tenant`),
    duracionObjetivoMs: duracion(d.smoke?.duracion_objetivo, `${ruta}: smoke.duracion_objetivo`),
  };

  const fases: Fase[] = (d.carga?.fases ?? []).map((f: any, i: number): Fase => ({
    nombre: texto(f?.nombre, `${ruta}: carga.fases[${i}].nombre`),
    duracionMs: duracion(f?.duracion, `${ruta}: carga.fases[${i}].duracion`),
    ritmo: num(f?.ritmo, `${ruta}: carga.fases[${i}].ritmo`),
  }));

  if (modo === 'carga' && fases.length === 0) {
    throw new Error(`${ruta}: modo 'carga' pero carga.fases esta vacio`);
  }
  const carga: PerfilCarga = { fases };

  const tipoReparto = d.reparto?.tipo ?? 'zipf';
  if (tipoReparto !== 'zipf' && tipoReparto !== 'uniforme') {
    throw new Error(`${ruta}: reparto.tipo debe ser 'zipf' o 'uniforme'`);
  }
  const reparto: Reparto = {
    tipo: tipoReparto,
    exponente: d.reparto?.exponente === undefined ? 1.0 : num(d.reparto.exponente, `${ruta}: reparto.exponente`),
  };

  const tipoLlegadas = d.llegadas?.tipo ?? 'poisson';
  if (tipoLlegadas !== 'poisson' && tipoLlegadas !== 'uniforme') {
    throw new Error(`${ruta}: llegadas.tipo debe ser 'poisson' o 'uniforme'`);
  }
  const llegadas: Llegadas = {
    tipo: tipoLlegadas,
    tickMs: entero(d.llegadas?.tick_ms ?? 10, `${ruta}: llegadas.tick_ms`, 1),
  };

  const tamanoBytes = rango(d.pool?.tamano_bytes ?? [BYTES_MAXIMO, BYTES_MAXIMO], `${ruta}: pool.tamano_bytes`);

  // El piso NO es una preferencia: el esqueleto del documento fiscal de
  // docs/02-payload.md pesa 1.240 bytes canonicos sin un solo item, y 1.403
  // con el item minimo. Pedir plantillas por debajo de eso obligaria a
  // mutilar el documento, y un documento mutilado no compara con nada.
  const piso = BYTES_MINIMO_VIABLE + RESERVA_RELLENO;
  if (tamanoBytes[0] < piso) {
    throw new Error(
      `${ruta}: pool.tamano_bytes[0] = ${tamanoBytes[0]}, pero el documento fiscal ` +
      `no baja de ${BYTES_MINIMO_VIABLE} bytes canonicos con un solo item ` +
      `(+${RESERVA_RELLENO} de relleno reservado). Minimo admisible: ${piso}.`,
    );
  }
  if (tamanoBytes[1] > BYTES_MAXIMO) {
    // Se avisa pero no se bloquea: el techo de 3.072 es del diseño, no de SQS
    // (que admite 256 KB). Si alguien lo sube a proposito, que quede en el log.
    Logger.warn(
      `pool.tamano_bytes[1] = ${tamanoBytes[1]} supera el techo de diseño de ${BYTES_MAXIMO} B ` +
      `(docs/02-payload.md). Los numeros dejan de ser comparables con los del documento.`,
      ConfigService.name,
    );
  }

  const peticiones: Peticiones = {
    porCliente: rangoRitmo(d.peticiones?.client, `${ruta}: peticiones.client`),
  };

  const pool: Pool = {
    plantillas: entero(d.pool?.plantillas ?? 1000, `${ruta}: pool.plantillas`, 1),
    semilla: entero(d.pool?.semilla ?? 1, `${ruta}: pool.semilla`, 0),
    tamanoBytes,
    itemsPorDocumento: rango(d.pool?.items_por_documento ?? [1, 5], `${ruta}: pool.items_por_documento`),
    eventosPorHilo: entero(d.pool?.eventos_por_hilo ?? 1, `${ruta}: pool.eventos_por_hilo`, 1),
    tasaVerificacion: fraccion(d.pool?.tasa_verificacion ?? 0.01, `${ruta}: pool.tasa_verificacion`),
  };

  const envio: Envio = {
    ruta: texto(d.envio?.ruta ?? '/events', `${ruta}: envio.ruta`),
    pruebaId: d.envio?.prueba_id === undefined || d.envio?.prueba_id === null
      ? null
      : idPrueba(d.envio.prueba_id, `${ruta}: envio.prueba_id`),
    eventosPorRequest: entero(d.envio?.eventos_por_request ?? 20, `${ruta}: envio.eventos_por_request`, 1),
    esperaMaximaLoteMs: entero(d.envio?.espera_maxima_lote_ms ?? 200, `${ruta}: envio.espera_maxima_lote_ms`, 0),
    concurrenciaPorTenant: entero(d.envio?.concurrencia_por_tenant ?? 0, `${ruta}: envio.concurrencia_por_tenant`, 0),
    timeoutMs: entero(d.envio?.timeout_ms ?? 5000, `${ruta}: envio.timeout_ms`, 1),
    conexionesPorDestino: entero(d.envio?.conexiones_por_destino ?? 32, `${ruta}: envio.conexiones_por_destino`, 1),
    reintentos: entero(d.envio?.reintentos ?? 0, `${ruta}: envio.reintentos`, 0),
  };

  if (envio.reintentos > 0) {
    // No es un error, pero tiene que quedar dicho: reintentar falsea O-06.
    // El mismo evento se contaria dos veces como carga ofrecida.
    Logger.warn(
      `envio.reintentos=${envio.reintentos}: los reintentos inflan la carga ofrecida y ` +
      `distorsionan la comparacion ofrecido/aceptado (O-06)`,
      ConfigService.name,
    );
  }

  const eventos: EventosPorPeticion = {
    porPeticion: rangoRitmo(d.eventos?.client, `${ruta}: eventos.client`),
  };
  // Un rango de peticiones SI puede empezar en 0 —hay segundos sin trafico—,
  // pero una peticion con 0 documentos no es nada: seria un POST con el array
  // vacio, que C3 contesta 202 sin haber recibido un solo evento. Contaria
  // como peticion enviada y como cero eventos, y el ritmo medido mentiria.
  if (eventos.porPeticion && eventos.porPeticion.min < 1) {
    throw new Error(
      `${ruta}: eventos.client empieza en ${eventos.porPeticion.min}; una peticion ` +
        `lleva al menos 1 documento.`,
    );
  }

  return { modo, smoke, carga, reparto, llegadas, peticiones, eventos, pool, envio };
}

// ---------------------------------------------------------------------------
// Validadores
// ---------------------------------------------------------------------------

function num(v: unknown, campo: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`${campo}: se esperaba un numero, vino ${JSON.stringify(v)}`);
  }
  return v;
}

function entero(v: unknown, campo: string, min: number): number {
  const n = num(v, campo);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`${campo}: se esperaba un entero >= ${min}, vino ${n}`);
  }
  return n;
}

function fraccion(v: unknown, campo: string): number {
  const n = num(v, campo);
  if (n < 0 || n > 1) throw new Error(`${campo}: se esperaba un valor entre 0 y 1, vino ${n}`);
  return n;
}

function texto(v: unknown, campo: string): string {
  if (typeof v !== 'string' || !v) throw new Error(`${campo}: se esperaba texto no vacio`);
  return v;
}

function rango(v: unknown, campo: string): [number, number] {
  // Un escalar es un rango degenerado: `tamano_bytes: 3072` sigue siendo la
  // forma de pedir tamaño fijo, sin tener que escribir [3072, 3072].
  if (typeof v === 'number') {
    const n = entero(v, campo, 1);
    return [n, n];
  }
  if (!Array.isArray(v) || v.length !== 2) {
    throw new Error(`${campo}: se esperaba [min, max] o un numero`);
  }
  const min = entero(v[0], `${campo}[0]`, 1);
  const max = entero(v[1], `${campo}[1]`, 1);
  if (max < min) throw new Error(`${campo}: max (${max}) < min (${min})`);
  return [min, max];
}

/**
 * `{ min, max }` de eventos/s. Acepta tambien `[min, max]` y un escalar, que
 * es un rango degenerado — asi `client: 40` sigue significando 40 ev/s fijos.
 */
export function rangoRitmo(v: unknown, campo: string): Rango | null {
  if (v === undefined || v === null) return null;

  let min: unknown, max: unknown;
  if (typeof v === 'number') { min = v; max = v; }
  else if (Array.isArray(v) && v.length === 2) { min = v[0]; max = v[1]; }
  else if (typeof v === 'object') { min = (v as any).min; max = (v as any).max; }
  else throw new Error(`${campo}: se esperaba { min, max }, [min, max] o un numero`);

  const a = num(min, `${campo}.min`);
  const b = num(max, `${campo}.max`);
  if (a < 0) throw new Error(`${campo}.min debe ser >= 0, vino ${a}`);
  if (b < a) throw new Error(`${campo}: max (${b}) es menor que min (${a})`);
  return { min: a, max: b };
}

/**
 * El identificador de prueba acaba siendo parte de un NOMBRE DE ARCHIVO en
 * c3/logs. Restringirlo aqui evita que una barra o un '..' escriban donde no
 * deben, y que un id con espacios rompa la cabecera HTTP.
 */
export function idPrueba(v: unknown, campo: string): string {
  const s = String(v).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(s)) {
    throw new Error(
      `${campo}: '${s}' no vale como identificador. Solo letras, digitos, ` +
      `punto, guion y guion bajo; hasta 64 caracteres; sin empezar por separador.`,
    );
  }
  return s;
}

/** '15m', '90s', '2h', o un numero suelto interpretado como segundos. */
export function duracion(v: unknown, campo: string): number {
  if (typeof v === 'number') return entero(v, campo, 0) * 1000;
  if (typeof v !== 'string') throw new Error(`${campo}: se esperaba '15m', '90s' o '2h'`);

  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)$/.exec(v.trim());
  if (!m) throw new Error(`${campo}: formato invalido '${v}'. Usa 500ms, 90s, 15m o 2h.`);

  const n = Number(m[1]);
  switch (m[2]) {
    case 'ms': return Math.round(n);
    case 's':  return Math.round(n * 1000);
    case 'm':  return Math.round(n * 60_000);
    case 'h':  return Math.round(n * 3_600_000);
    default:   throw new Error(`${campo}: unidad desconocida`);
  }
}
