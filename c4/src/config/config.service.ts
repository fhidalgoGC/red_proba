import { Injectable, Logger } from '@nestjs/common';

/**
 * Configuracion del consumidor. Todo por variable de entorno: una sola
 * imagen, igual que C3 (D-07).
 *
 * Falla en el constructor si falta lo esencial. Un consumidor que arranca
 * "sano" apuntando a ninguna parte es peor que uno que no arranca: el health
 * check queda en verde y nadie se entera de que P4 no se esta midiendo.
 */
@Injectable()
export class ConfigService {
  private readonly logger = new Logger(ConfigService.name);

  /** Cola FIFO de C4. La escribe terraform (modules/c4). */
  readonly colaUrl: string;
  /** DLQ. G-07: lo que no descifra o no verifica se manda aca a mano. */
  readonly dlqUrl: string | null;
  readonly region: string;

  /** G-01: lotes de 10 y long polling de 20 s. */
  readonly loteMax: number;
  readonly esperaSegundos: number;

  /**
   * Borrar el mensaje despues de procesarlo.
   *
   * Por defecto SI. Con `C4_BORRAR=false` se puede espiar la cola sin
   * consumirla, pero es un modo de inspeccion, no de corrida: el mensaje
   * reaparece al vencer el visibility timeout y se reprocesa hasta agotar
   * maxReceiveCount y caer en la DLQ.
   */
  readonly borrar: boolean;

  /** Cada cuanto se emite la linea de resumen acumulado. */
  readonly resumenCadaMs: number;

  // ── Postgres de C4 ──
  readonly bdUrl: string;
  readonly bdPoolMax: number;
  readonly bdEsquema: string;
  /** Guardar el payload en claro en el journal. */
  readonly guardarPayload: boolean;

  /**
   * ⚠ Llaves de firma ACEPTADAS. Es una lista blanca, no una sugerencia.
   *
   * El `key_id` viaja DENTRO del sobre, en claro, y lo escribio quien
   * publico. Verificar con la llave que el propio mensaje pide es verificar
   * que el mensaje se firmo a si mismo: cualquiera que pueda publicar en la
   * cola firma con SU llave, pone su ARN en `key_id` y la firma verifica
   * perfectamente. La lista blanca es lo que convierte la verificacion en una
   * afirmacion sobre QUIEN firmo.
   *
   * Vacia = se acepta cualquier `key_id`. Arranca igual, pero grita.
   */
  readonly llavesFirmaAceptadas: Set<string>;

  /**
   * Llave simetrica de mensajes de C4. Opcional pero recomendada: se le pasa
   * a `Decrypt` para que un blob de otra llave falle diciendo que no es de
   * aqui, en vez de dar un AccessDenied que no distingue "no tengo permiso"
   * de "esto no es mio".
   */
  readonly llaveMensajes: string | null;

  /** Salir cuando la cola lleve N ciclos vacios seguidos. Para pruebas. */
  readonly salirTrasVaciosSeguidos: number;

  constructor() {
    const url = process.env.SQS_QUEUE_URL?.trim();
    if (!url) {
      throw new Error('falta SQS_QUEUE_URL: el consumidor no tiene de donde leer');
    }
    this.colaUrl = url;
    this.dlqUrl = process.env.SQS_DLQ_URL?.trim() || null;

    this.region =
      process.env.AWS_REGION?.trim() ||
      process.env.AWS_DEFAULT_REGION?.trim() ||
      regionDesdeUrl(url) ||
      'us-west-2';

    this.loteMax = acotar(numero('SQS_BATCH_SIZE', 10), 1, 10);
    this.esperaSegundos = acotar(numero('SQS_WAIT_SECONDS', 20), 0, 20);
    this.borrar = process.env.C4_BORRAR !== 'false';
    this.resumenCadaMs = Math.max(1000, numero('C4_RESUMEN_MS', 10_000));

    const bd = process.env.DATABASE_URL?.trim();
    if (!bd) {
      throw new Error('falta DATABASE_URL: sin base no hay e10, y e10 es el final de la medicion');
    }
    this.bdUrl = bd;
    this.bdPoolMax = Math.max(1, numero('C4_BD_POOL', 10));
    this.bdEsquema = process.env.C4_ESQUEMA?.trim() || 'c4';
    this.guardarPayload = process.env.C4_GUARDAR_PAYLOAD !== 'false';

    this.llavesFirmaAceptadas = new Set(
      (process.env.C4_LLAVES_FIRMA ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );

    this.llaveMensajes = process.env.KMS_ENCRYPT_KEY_ID?.trim() || null;
    this.salirTrasVaciosSeguidos = numero('C4_SALIR_TRAS_VACIOS', 0);

    if (!this.colaUrl.endsWith('.fifo')) {
      this.logger.warn(`la cola no termina en .fifo: ${this.colaUrl}`);
    }
    if (!this.borrar) {
      this.logger.warn('C4_BORRAR=false · los mensajes NO se borran y reapareceran');
    }
    if (!this.dlqUrl) {
      this.logger.warn(
        'sin SQS_DLQ_URL · lo que no descifra o no verifica se contara y se borrara, ' +
          'pero NO quedara la evidencia en ninguna cola',
      );
    }
    if (this.llavesFirmaAceptadas.size === 0) {
      this.logger.warn(
        '⚠ C4_LLAVES_FIRMA vacia · se acepta el key_id que venga en el sobre. ' +
          'La firma prueba integridad pero NO prueba quien firmo.',
      );
    }
  }
}

/** `https://sqs.us-west-2.amazonaws.com/123/cola.fifo` → `us-west-2`. */
function regionDesdeUrl(url: string): string | null {
  return /^https?:\/\/sqs\.([a-z0-9-]+)\.amazonaws\.com/.exec(url)?.[1] ?? null;
}

function numero(clave: string, defecto: number): number {
  const bruto = process.env[clave];
  if (bruto === undefined || bruto.trim() === '') return defecto;
  const n = Number(bruto);
  return Number.isFinite(n) ? n : defecto;
}

function acotar(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(n)));
}
