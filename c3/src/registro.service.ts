import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Registro por minuto de lo que llega a C3.
 *
 * Escribe `c3/logs/<prueba>__<tenant>.json`: UN objeto JSON valido por
 * archivo, con las ventanas de un minuto dentro de `minutos[]` y los
 * acumulados en `totales`. Se abre en cualquier editor, `jq .` lo formatea
 * entero y no hace falta parser propio.
 *
 * ────────────────────────────────────────────────────────────────────────
 * POR QUE AGRUPADO POR PRUEBA
 *
 * Cada request del orquestador trae la cabecera `x-prueba-id`. Sin ella, dos
 * corridas lanzadas con pocos minutos de diferencia caerian en el mismo
 * bucket y no habria manera de separarlas despues.
 *
 * La marca va en CABECERA y no dentro del documento a proposito: el payload
 * se firma, y meterle metadatos de la prueba cambiaria lo que se firma. Es la
 * misma regla que mantiene las marcas de tiempo fuera del payload.
 * ────────────────────────────────────────────────────────────────────────
 *
 * CUANDO SE CIERRA UNA VENTANA. El bucket es el minuto, pero esperar al
 * cambio de minuto haria inservible el log para una corrida de 20 segundos:
 * terminarias la prueba y el archivo seguiria vacio. Se cierra cuando pasa
 * cualquiera de estas tres:
 *
 *   1. el minuto termino                    -> completo: true
 *   2. la prueba lleva SILENCIO_MS callada   -> completo: false
 *   3. el proceso recibe SIGTERM             -> completo: false
 *
 * La ventana dice cual fue, para que nadie confunda un minuto parcial con un
 * minuto flojo.
 */

const SILENCIO_MS = 8_000;
const TICK_MS = 1_000;
const SIN_ID = 'sin-id';

interface Ventana {
  minuto: string;
  completo: boolean;
  cerrado_por: string;
  peticiones: number;
  eventos: number;
  bytes: number;
  bytes_medios_por_evento: number;
  eventos_por_peticion: number;
  peticiones_por_s: number;
  eventos_por_s: number;
  mb_por_s: number;
  event_ids_unicos: number;
  event_ids_duplicados: number;
  primera: string;
  ultima: string;
  ventana_activa_s: number;
}

interface Archivo {
  prueba: string;
  tenant: string;
  actualizado: string;
  totales: {
    peticiones: number;
    eventos: number;
    bytes: number;
    bytes_medios_por_evento: number | null;
    event_ids_unicos: number;
    event_ids_duplicados: number;
  };
  minutos: Ventana[];
}

interface Bucket {
  prueba: string;
  minuto: number;          // epoch en minutos
  peticiones: number;
  eventos: number;
  bytes: number;
  eventIds: Set<string>;
  duplicados: number;
  primera: number;
  ultima: number;
}

@Injectable()
export class RegistroService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RegistroService.name);

  private readonly dir = resolve(
    process.env.C3_LOGS_DIR ?? join(__dirname, '..', 'logs'),
  );
  private readonly tenant = process.env.TENANT_ID ?? `puerto-${process.env.C3_PORT ?? process.env.PORT ?? '3001'}`;

  /** Un bucket abierto por prueba. Clave: prueba id. */
  private readonly abiertos = new Map<string, Bucket>();
  /** El contenido de cada archivo, en memoria. Clave: prueba id. */
  private readonly archivos = new Map<string, Archivo>();
  /** event_id vistos por prueba, para detectar duplicados entre minutos. */
  private readonly vistos = new Map<string, Set<string>>();

  private timer: NodeJS.Timeout | null = null;

  onModuleInit(): void {
    mkdirSync(this.dir, { recursive: true });
    this.timer = setInterval(() => this.revisar(), TICK_MS);
    this.timer.unref();   // que un timer no impida cerrar el proceso
    this.logger.log(`registro por minuto en ${this.dir}`);
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    // Cerrar lo que quede abierto: sin esto, la ultima ventana de cada prueba
    // se pierde justo cuando mas interesa — al final de la corrida.
    for (const p of [...this.abiertos.keys()]) this.cerrar(p, 'apagado');
  }

  // -------------------------------------------------------------------------

  anotar(prueba: string | undefined, documentos: unknown[], bytes: number): void {
    const id = normalizar(prueba);
    const ahora = Date.now();
    const minuto = Math.floor(ahora / 60_000);

    let b = this.abiertos.get(id);
    if (b && b.minuto !== minuto) {
      // Cambio de minuto: se cierra el anterior antes de abrir el nuevo.
      this.cerrar(id, 'minuto');
      b = undefined;
    }
    if (!b) {
      b = {
        prueba: id, minuto,
        peticiones: 0, eventos: 0, bytes: 0,
        eventIds: new Set(), duplicados: 0,
        primera: ahora, ultima: ahora,
      };
      this.abiertos.set(id, b);
    }

    b.peticiones++;
    b.eventos += documentos.length;
    b.bytes += bytes;
    b.ultima = ahora;

    // Los event_id se comparan contra TODA la prueba, no solo contra este
    // minuto: un duplicado que cruza la frontera del minuto sigue siendo un
    // duplicado, y es exactamente el fallo que SQS FIFO se tragaria en
    // silencio.
    let global = this.vistos.get(id);
    if (!global) { global = new Set(); this.vistos.set(id, global); }

    for (const d of documentos) {
      const ev = (d as { event_id?: unknown })?.event_id;
      if (typeof ev === 'string') {
        if (global.has(ev)) b.duplicados++;
        else { global.add(ev); b.eventIds.add(ev); }
      }
    }
  }

  private revisar(): void {
    const ahora = Date.now();
    const minuto = Math.floor(ahora / 60_000);
    for (const [id, b] of this.abiertos) {
      if (b.minuto !== minuto) this.cerrar(id, 'minuto');
      else if (ahora - b.ultima >= SILENCIO_MS) this.cerrar(id, 'silencio');
    }
  }

  private cerrar(id: string, motivo: 'minuto' | 'silencio' | 'apagado'): void {
    const b = this.abiertos.get(id);
    if (!b || b.peticiones === 0) { this.abiertos.delete(id); return; }
    this.abiertos.delete(id);

    const duracionS = Math.max(0.001, (b.ultima - b.primera) / 1000);
    const ventana: Ventana = {
      minuto: new Date(b.minuto * 60_000).toISOString(),
      completo: motivo === 'minuto',
      cerrado_por: motivo,

      peticiones: b.peticiones,
      eventos: b.eventos,
      bytes: b.bytes,

      bytes_medios_por_evento: Math.round(b.bytes / b.eventos),
      eventos_por_peticion: +(b.eventos / b.peticiones).toFixed(2),
      // Sobre la ventana ACTIVA, no sobre los 60 s: en un minuto parcial
      // dividir por 60 daria un ritmo inventado hacia abajo.
      peticiones_por_s: +(b.peticiones / duracionS).toFixed(1),
      eventos_por_s: +(b.eventos / duracionS).toFixed(1),
      mb_por_s: +(b.bytes / duracionS / 1024 / 1024).toFixed(3),

      event_ids_unicos: b.eventIds.size,
      event_ids_duplicados: b.duplicados,

      primera: new Date(b.primera).toISOString(),
      ultima: new Date(b.ultima).toISOString(),
      ventana_activa_s: +duracionS.toFixed(1),
    };

    const archivo = this.cargar(id);
    archivo.minutos.push(ventana);
    archivo.actualizado = new Date().toISOString();

    const t = archivo.totales;
    t.peticiones += ventana.peticiones;
    t.eventos += ventana.eventos;
    t.bytes += ventana.bytes;
    t.event_ids_unicos += ventana.event_ids_unicos;
    t.event_ids_duplicados += ventana.event_ids_duplicados;
    t.bytes_medios_por_evento = t.eventos === 0 ? null : Math.round(t.bytes / t.eventos);

    if (!this.guardar(id, archivo)) return;

    this.logger.log(
      `[${id}] ${ventana.minuto.slice(11, 16)} · ` +
      `${ventana.peticiones} peticiones · ${ventana.eventos} eventos · ` +
      `${(ventana.bytes / 1024).toFixed(1)} KB · ${ventana.eventos_por_s} ev/s` +
      (ventana.completo ? '' : ` (parcial, ${motivo})`) +
      (ventana.event_ids_duplicados > 0 ? `  ⚠ ${ventana.event_ids_duplicados} event_id DUPLICADOS` : ''),
    );
  }

  // -------------------------------------------------------------------------
  // Archivo
  // -------------------------------------------------------------------------

  private ruta(id: string): string {
    return join(this.dir, `${id}__${sanear(this.tenant)}.json`);
  }

  /**
   * El archivo en memoria; si no esta, se lee del disco.
   *
   * Leerlo importa: si el proceso se reinicia a media prueba y empezaramos con
   * el objeto vacio, el primer guardado PISARIA las ventanas ya escritas. Con
   * JSON Lines esto no hacia falta porque solo se anexaba; con un JSON entero
   * hay que releer antes de reescribir.
   */
  private cargar(id: string): Archivo {
    const enMemoria = this.archivos.get(id);
    if (enMemoria) return enMemoria;

    let archivo: Archivo | null = null;
    try {
      const crudo = readFileSync(this.ruta(id), 'utf8');
      const doc = JSON.parse(crudo) as Archivo;
      if (Array.isArray(doc?.minutos)) archivo = doc;
    } catch {
      // No existe todavia, o quedo ilegible. Se empieza de cero.
    }

    archivo ??= {
      prueba: id,
      tenant: this.tenant,
      actualizado: new Date().toISOString(),
      totales: {
        peticiones: 0, eventos: 0, bytes: 0,
        bytes_medios_por_evento: null,
        event_ids_unicos: 0, event_ids_duplicados: 0,
      },
      minutos: [],
    };

    this.archivos.set(id, archivo);
    return archivo;
  }

  /**
   * Escritura atomica: temporal + rename.
   *
   * Reescribir el archivo entero en cada ventana significa que un fallo a
   * media escritura dejaria el JSON truncado y perderias la corrida completa,
   * no solo la ultima linea. Con rename, o esta el archivo viejo o el nuevo.
   */
  private guardar(id: string, archivo: Archivo): boolean {
    const destino = this.ruta(id);
    const temporal = destino + '.tmp';
    try {
      writeFileSync(temporal, JSON.stringify(archivo, null, 2) + '\n', 'utf8');
      renameSync(temporal, destino);
      return true;
    } catch (e) {
      // Que no se pueda escribir el log NO debe tumbar al receptor: perderias
      // la corrida entera por un problema de disco.
      this.logger.error(`no se pudo escribir ${destino}: ${(e as Error).message}`);
      return false;
    }
  }

  // -------------------------------------------------------------------------

  get carpeta(): string { return this.dir; }
  get tenantId(): string { return this.tenant; }

  resumen() {
    return {
      tenant: this.tenant,
      logs: this.dir,
      pruebas: [...this.archivos.entries()].map(([prueba, a]) => ({
        prueba,
        ...a.totales,
        ventanas: a.minutos.length,
        minuto_abierto: this.abiertos.has(prueba),
        archivo: this.ruta(prueba),
      })),
    };
  }
}

/** Un id ausente o con forma rara no puede acabar en un nombre de archivo. */
function normalizar(prueba: string | undefined): string {
  if (!prueba) return SIN_ID;
  const s = prueba.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(s) ? s : SIN_ID;
}

const sanear = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, '-');
