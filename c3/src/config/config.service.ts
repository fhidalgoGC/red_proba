/**
 * El contrato de arranque de C3 (CLAUDE.md).
 *
 * Una sola imagen sirve a los 50 tenants; todo lo que cambia son estas
 * variables (D-07). Se leen y se validan UNA VEZ, al construir: un contenedor
 * mal configurado tiene que morir al arrancar, no a los diez minutos con el
 * primer evento que no puede firmar.
 *
 * ⚠ `DATABASE_URL` es obligatoria desde C-05 y `SQS_QUEUE_URL` desde C-06: el
 * outbox es la unica fuente de lo que llega a C4 y el relay su unica salida.
 * Un C3 sin base o sin cola no puede entregar nada, y arrancarlo seria peor
 * que no arrancarlo — contestaria 202 a eventos que jamas van a viajar.
 */
import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class ConfigService {
  private readonly logger = new Logger('config');

  /** Identificador del tenant. Es la entrada del HMAC de pseudonimizacion. */
  readonly tenantId: string;

  readonly region: string;

  /** Llave Ed25519 de firma, en el KMS de C3. `null` = modo local. */
  readonly llaveFirma: string | null;

  /** Llave HMAC de pseudonimizacion, en el KMS de C3. `null` = modo local. */
  readonly llaveHmac: string | null;

  /** Llave simetrica de C4. C3 solo puede `GenerateDataKey` sobre ella. */
  readonly llaveCifrado: string | null;

  /**
   * Cuantos eventos comparten una data key (C-04).
   *
   * `GenerateDataKey` es simetrica y barata, pero una llamada por evento
   * duplicaria el trafico a KMS sin comprar nada: la misma data key cifra N
   * sobres con un IV distinto cada uno, que es donde esta la seguridad.
   * C4 cachea por `edk`, asi que reusarla le ahorra tambien a el un `Decrypt`
   * por mensaje.
   */
  readonly eventosPorDataKey: number;

  /**
   * ⚠ MODO LOCAL — sin KMS.
   *
   * Se activa solo si NO estan las tres llaves. Sirve para correr el pipeline
   * en un portatil sin credenciales, y para nada mas: lo que produce NO lo
   * puede abrir C4. La `edk` no sale de `GenerateDataKey`, asi que su
   * `Decrypt` falla; y la Ed25519 no esta en la lista blanca de
   * `C4_LLAVES_FIRMA`, asi que la firma se rechaza. Los dos casos terminan en
   * la DLQ con alarma.
   */
  readonly modoLocal: boolean;

  /** Postgres del tenant. Obligatoria: sin outbox no hay entrega. */
  readonly bdUrl: string;
  readonly bdPoolMax: number;
  readonly bdEsquema: string;

  // ── C-06 · el relay ──
  /** Cola FIFO de C4. Obligatoria: es la unica salida de C3. */
  readonly colaUrl: string;
  /** Cada cuanto despierta el relay. `OUTBOX_POLL_MS`. */
  readonly pollMs: number;
  /** Filas por tick. Tope de SQS SendMessageBatch: 10. */
  readonly loteRelay: number;
  /** Intentos antes de mandar la fila a FAILED. */
  readonly maxIntentos: number;
  /** Techo del backoff exponencial, en segundos. */
  readonly backoffCapSeg: number;

  constructor() {
    this.tenantId = process.env.TENANT_ID?.trim() || `puerto-${process.env.C3_PORT ?? '3001'}`;

    this.llaveFirma = process.env.KMS_SIGN_KEY_ID?.trim() || null;
    this.llaveHmac = process.env.KMS_HMAC_KEY_ID?.trim() || null;
    this.llaveCifrado = process.env.KMS_ENCRYPT_KEY_ID?.trim() || null;

    this.region =
      process.env.AWS_REGION?.trim() || process.env.AWS_DEFAULT_REGION?.trim() || 'us-west-2';

    this.eventosPorDataKey = Math.max(1, entero('C3_EVENTOS_POR_DATA_KEY', 100));

    const bd = process.env.DATABASE_URL?.trim();
    if (!bd) {
      throw new Error(
        'falta DATABASE_URL. Desde C-05 el outbox es la unica fuente de lo que llega a C4: ' +
          'sin base, C3 contestaria 202 a eventos que nunca se van a publicar.',
      );
    }
    this.bdUrl = bd;
    this.bdPoolMax = Math.max(1, entero('C3_BD_POOL', 10));
    this.bdEsquema = process.env.C3_ESQUEMA?.trim() || 'c3';

    const cola = process.env.SQS_QUEUE_URL?.trim();
    if (!cola) {
      throw new Error(
        'falta SQS_QUEUE_URL. Es la unica salida de C3: sin ella el outbox se llena y ' +
          'nada llega a C4, con el contenedor en verde y sin un solo error.',
      );
    }
    this.colaUrl = cola;
    this.pollMs = Math.max(50, entero('OUTBOX_POLL_MS', 500));
    // 10 es el maximo de SendMessageBatch. Pedir mas seria pedir filas que
    // no caben en el envio y tener que devolverlas.
    this.loteRelay = Math.min(10, Math.max(1, entero('OUTBOX_BATCH_SIZE', 10)));
    this.maxIntentos = Math.max(1, entero('OUTBOX_MAX_ATTEMPTS', 10));
    this.backoffCapSeg = Math.max(1, entero('OUTBOX_BACKOFF_CAP_SEC', 300));

    const llaves = [this.llaveFirma, this.llaveHmac, this.llaveCifrado];
    const puestas = llaves.filter(Boolean).length;
    this.modoLocal = puestas === 0;

    if (puestas > 0 && puestas < llaves.length) {
      // A medias es peor que ninguna: firmaria con KMS y cifraria en local, o
      // al reves, y el fallo aparece recien en C4 como «no descifra».
      throw new Error(
        'las llaves de KMS van todas o ninguna. Faltan: ' +
          [
            this.llaveFirma ? null : 'KMS_SIGN_KEY_ID',
            this.llaveHmac ? null : 'KMS_HMAC_KEY_ID',
            this.llaveCifrado ? null : 'KMS_ENCRYPT_KEY_ID',
          ]
            .filter(Boolean)
            .join(', '),
      );
    }

    if (!this.colaUrl.endsWith('.fifo')) {
      // Sin FIFO no hay MessageGroupId ni deduplicacion: el orden por
      // expediente y la idempotencia de C4 dependen de los dos.
      this.logger.warn(`la cola no termina en .fifo: ${this.colaUrl}`);
    }

    if (this.modoLocal) {
      this.logger.warn(
        '⚠ MODO LOCAL · sin KMS. Se firma con una Ed25519 del proceso y se cifra con una ' +
          'data key local. C4 NO puede abrir esto: la edk no descifra y la llave no esta ' +
          'en su lista blanca. Sirve para probar el pipeline, no para producir nada real.',
      );
    }
  }
}

function entero(nombre: string, porDefecto: number): number {
  const v = process.env[nombre]?.trim();
  if (!v) return porDefecto;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`${nombre}='${v}' no es un entero`);
  return n;
}
