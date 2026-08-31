import { Injectable, Logger } from '@nestjs/common';
import { join, resolve } from 'node:path';

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
   * Cuantos lazos de recepcion corren a la vez. `C4_CONCURRENCIA`.
   *
   * NO son hilos: son N invocaciones del mismo `lazoPrincipal()`, cada una con
   * sus variables locales, sobre el unico hilo de JavaScript. Funciona porque
   * un ciclo se pasa ~40 de cada 50 ms ESPERANDO a SQS: mientras un lazo
   * espera, otro procesa.
   *
   * ⚠ Con 1 -el defecto- el comportamiento es identico al de antes de que esto
   *   existiera. Subirlo es una decision de la corrida, no del despliegue.
   *
   * ⚠ SQS entrega 10 mensajes como maximo por llamada. Ese es el motivo de que
   *   subir `SQS_BATCH_SIZE` no sea alternativa: para 3.000 msg/s hacen falta
   *   300 llamadas/s, y con una sola en vuelo el techo son ~40.
   *
   * ⚠ NO ROMPE EL ORDEN. Mientras un mensaje de un MessageGroupId este en
   *   vuelo, SQS no entrega otro de ese grupo A NADIE. Dos lazos no pueden
   *   tener a la vez eventos del mismo expediente.
   */
  readonly concurrencia: number;

  /**
   * Persistir el lote entero en UNA transaccion. `C4_LOTE_TRANSACCION`.
   *
   * ⚠ APAGADO POR DEFECTO, y no por prudencia generica: CAMBIA LO QUE MIDE P1.
   *   Con un solo COMMIT los N eventos se persisten en el mismo instante -es
   *   la verdad, no una aproximacion- pero el tramo e9→e10 deja de medir "lo
   *   que tardo ESTE evento" y pasa a medir "lo que tardo su lote".
   *
   *   Encenderlo es una decision de la corrida. Lo que NO se puede es
   *   comparar una corrida con esto y otra sin esto y llamar a la diferencia
   *   una mejora de latencia.
   *
   * A cambio: ~7 viajes a RDS y un fsync por lote, en vez de ~8 viajes y un
   * fsync por MENSAJE.
   */
  readonly loteTransaccion: boolean;

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

  /**
   * G-09 · puerto del `/health`. 0 lo apaga y C4 vuelve a ser worker puro.
   *
   * No convierte a C4 en un API: es la unica forma de preguntarle si SIGUE
   * viendo su base. Sin esto, un C4 vivo con el Postgres caido saca mensajes
   * de la cola, no los persiste y P4 da de menos — en silencio.
   */
  readonly puertoSalud: number;
  /** Por defecto localhost: el health es para quien opera, no para la red. */
  readonly hostSalud: string;

  /**
   * Carpeta de los informes del ledger (G-08).
   *
   * Aqui la escribe `npm run informe` y de aqui la sirve `GET /logs/:id`. Una
   * sola variable para los dos: si cada uno resolviera su ruta, el CLI podria
   * estar escribiendo donde el endpoint no mira y el 404 no diria por que.
   */
  readonly dirLogs: string;

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
    // El techo de 64 es una valvula, no un limite tecnico: por encima de eso
    // el cuello ya es la base o el propio hilo de JS, y lo unico que se
    // consigue es una cola de transacciones esperando conexion.
    this.concurrencia = acotar(numero('C4_CONCURRENCIA', 1), 1, 64);
    this.loteTransaccion = process.env.C4_LOTE_TRANSACCION === 'true';
    this.esperaSegundos = acotar(numero('SQS_WAIT_SECONDS', 20), 0, 20);
    this.borrar = process.env.C4_BORRAR !== 'false';
    this.resumenCadaMs = Math.max(1000, numero('C4_RESUMEN_MS', 10_000));

    const bd = urlDeBase();
    if (!bd) {
      throw new Error(
        'falta DATABASE_URL (o DB_HOST + DB_USER + DB_PASSWORD): sin base no hay e10, ' +
          'y e10 es el final de la medicion',
      );
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

    this.puertoSalud = acotar(numero('C4_PORT', 3003), 0, 65_535);
    this.hostSalud = process.env.C4_HEALTH_HOST?.trim() || '127.0.0.1';
    this.dirLogs = resolve(process.env.C4_LOGS_DIR?.trim() || join(__dirname, '..', '..', 'logs'));

    // ⚠ EL FALLO QUE NO DA NINGUN ERROR.
    //
    // Cada grupo del lote abre su propia transaccion, asi que el peor caso son
    // `concurrencia × loteMax` conexiones pedidas a la vez. Si el pool es mas
    // pequeño, las transacciones NO fallan: se ponen en cola esperando
    // conexion. El paralelismo simplemente no ocurre, el ritmo no mejora, y no
    // hay ni un log que lo explique.
    //
    // Por eso se grita al arrancar, que es el unico momento en que alguien
    // puede atarlo a lo que acaba de configurar.
    const conexionesPico = this.concurrencia * this.loteMax;
    if (this.bdPoolMax < conexionesPico) {
      this.logger.warn(
        `C4_BD_POOL=${this.bdPoolMax} se queda corto: ${this.concurrencia} lazo(s) × ` +
          `${this.loteMax} mensajes pueden pedir ${conexionesPico} conexiones a la vez. ` +
          'Las transacciones esperaran turno y el paralelismo no se notara — sin un solo ' +
          `error. Sube C4_BD_POOL a ${conexionesPico} o baja C4_CONCURRENCIA.`,
      );
    }

    if (this.loteTransaccion) {
      this.logger.warn(
        'C4_LOTE_TRANSACCION=true · un COMMIT por lote. e9→e10 mide el LOTE, no el ' +
          'evento: no compares esta corrida con una sin esto y llames latencia a la ' +
          'diferencia.',
      );
    }

    if (this.concurrencia > 1) {
      this.logger.log(
        `${this.concurrencia} lazos de recepcion concurrentes · pool ${this.bdPoolMax}`,
      );
    }

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

/**
 * La URL de Postgres — entera, o armada desde las partes.
 *
 * En local llega entera en `DATABASE_URL`. En Fargate NO PUEDE llegar entera:
 * la contrasena la inyecta ECS desde Secrets Manager en su propia variable, y
 * una task definition no sabe interpolar un secreto dentro de otra variable.
 * Asi que ahi llegan las piezas —`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`,
 * `DB_PASSWORD`— y la URL se arma aca.
 *
 * ⚠ `sslmode=no-verify`, no `require`. RDS PostgreSQL 15+ trae
 * `rds.force_ssl=1`: la conexion en claro se rechaza. Pero la CA de RDS no
 * esta en el trust store de Node, y `require` la verificaria y fallaria con
 * «self-signed certificate in certificate chain». `no-verify` cifra el
 * transporte sin verificar la cadena — que es lo que corresponde a una base
 * en una subnet sin ruta a internet, alcanzable solo desde su propio security
 * group. `DB_SSLMODE` lo deja cambiar sin recompilar.
 */
export function urlDeBase(): string | null {
  const entera = process.env.DATABASE_URL?.trim();
  if (entera) return entera;

  const host = process.env.DB_HOST?.trim();
  const usuario = process.env.DB_USER?.trim();
  if (!host || !usuario) return null;

  const clave = process.env.DB_PASSWORD ?? '';
  const puerto = process.env.DB_PORT?.trim() || '5432';
  const base = process.env.DB_NAME?.trim() || 'poc';
  const ssl = process.env.DB_SSLMODE?.trim() || 'no-verify';

  return (
    `postgres://${encodeURIComponent(usuario)}:${encodeURIComponent(clave)}` +
    `@${host}:${puerto}/${base}?sslmode=${ssl}`
  );
}
