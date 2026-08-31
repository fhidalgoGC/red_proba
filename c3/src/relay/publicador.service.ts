/**
 * C-06, primera mitad · publicar en la cola FIFO de C4.
 *
 * Es el ÚNICO canal entre C3 y C4: entre los dos dominios no hay ruta de red
 * (D-03). Lo que no salga por aquí no llega, y no hay segunda vía.
 *
 * ⚠ LOS DOS ATRIBUTOS VAN EN CLARO, y no es un descuido:
 *
 *   MessageGroupId         = rpf_id        ordena los eventos del expediente
 *   MessageDeduplicationId = payload_hash  sha256 del canonico EN CLARO
 *
 * El cuerpo esta cifrado, asi que SQS no puede leer nada de el. Si estos dos
 * viajaran dentro, la cola no tendria de donde sacar ni el orden ni la
 * deduplicacion. Y el dedup se calcula sobre el CLARO porque AES-GCM usa un IV
 * distinto cada vez: el mismo evento cifrado dos veces da bytes distintos, asi
 * que la deduplicacion por contenido de SQS no detectaria nunca un duplicado
 * (regla 5, D-11). Hay que desactivarla y mandar el id explicito.
 */
import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import {
  SendMessageBatchCommand,
  SQSClient,
  type SendMessageBatchRequestEntry,
} from '@aws-sdk/client-sqs';
import { ConfigService } from '../config/config.service';
import { ahora, msDesde } from '../metricas/muestras';
import type { Reclamado } from '../bd/outbox.repository';

/**
 * Errores que NO mejoran con el tiempo. Reintentar diez veces un
 * `InvalidParameterValue` no lo arregla: solo retrasa quince minutos el
 * momento de enterarte, con la fila girando en el relay mientras tanto.
 *
 * Los dos que de verdad se van a pegar en esta PoC son de configuracion:
 * `AccessDenied` cross-account —la resource policy de la cola, o el permiso
 * de `kms:GenerateDataKey`— y `QueueDoesNotExist`. El tamaño del mensaje no
 * es riesgo: 4,7 KB contra un limite de 256 KB.
 */
const PERMANENTES = new Set([
  'InvalidParameterValue',
  'InvalidMessageContents',
  'AccessDenied',
  'AccessDeniedException',
  'QueueDoesNotExist',
  'UnsupportedOperation',
  'InvalidAddress',
  'InvalidSecurity',
  'KMSAccessDenied',
  'KMSInvalidStateException',
]);

export interface ResultadoEnvio {
  /** Ids del outbox que SQS confirmo. */
  ok: string[];
  /** Los que fallaron y merecen reintento. */
  reintentar: Array<{ id: string; codigo: string; detalle: string }>;
  /** Los que fallaron por algo que no mejora: van a FAILED. */
  permanentes: Array<{ id: string; codigo: string; detalle: string }>;
  /** Instante en que SQS confirmo. Es `e6`. */
  e6: string;
  /**
   * Cuanto tardo la LLAMADA, en ms. Es el tramo e5→e6 medido con reloj
   * monotono en vez de restando dos ISO: la resta da milisegundos enteros y
   * una publicacion de 4,3 ms saldria como 4.
   *
   * Es de la llamada, no del mensaje: `SendMessageBatch` lleva hasta 10 sobres.
   * Cuenta tambien cuando la llamada FALLA — un timeout de 3 segundos es
   * informacion, y dejarlo fuera haria que el p99 mejorase justo cuando la
   * cola se cae.
   */
  ms: number;
}

@Injectable()
export class PublicadorService implements OnApplicationShutdown {
  private readonly logger = new Logger('publicador');
  private readonly sqs: SQSClient;

  readonly contadores = { envios: 0, mensajes: 0, ok: 0, fallidos: 0 };

  constructor(private readonly config: ConfigService) {
    // Singleton, igual que el cliente de KMS: uno por lote añadiria el
    // handshake TLS al tramo e5→e6 y mediriamos el handshake, no la cola.
    this.sqs = new SQSClient({ region: config.region });
  }

  onApplicationShutdown(): void {
    this.sqs.destroy();
  }

  /**
   * Publica un lote. `SendMessageBatch` acepta 10 mensajes y 256 KB en total;
   * con sobres de ~4,7 KB, diez caben con muchisimo margen.
   *
   * Un envio parcial es NORMAL, no una anomalia: la respuesta trae
   * `Successful` y `Failed` a la vez y hay que mirar los dos. Tratar la
   * llamada como todo-o-nada marcaria como fallidos mensajes que SQS ya
   * acepto — y entonces se reenviarian, que es exactamente el duplicado que
   * la deduplicacion tiene que atrapar. Funcionaria, pero por accidente.
   */
  async publicar(filas: Reclamado[]): Promise<ResultadoEnvio> {
    if (filas.length === 0) {
      return { ok: [], reintentar: [], permanentes: [], e6: new Date().toISOString(), ms: 0 };
    }

    const porId = new Map<string, Reclamado>();
    const entradas: SendMessageBatchRequestEntry[] = filas.map((f, i) => {
      // El Id es del LOTE, no del mensaje: solo tiene que ser unico dentro de
      // esta llamada. Se usa el indice y se traduce de vuelta con el mapa.
      const id = `m${i}`;
      porId.set(id, f);
      return {
        Id: id,
        MessageBody: JSON.stringify(f.envelope),
        MessageGroupId: f.rpfId,
        MessageDeduplicationId: f.payloadHash,
      };
    });

    this.contadores.envios += 1;
    this.contadores.mensajes += filas.length;

    let r;
    const t0 = ahora();
    try {
      r = await this.sqs.send(
        new SendMessageBatchCommand({ QueueUrl: this.config.colaUrl, Entries: entradas }),
      );
    } catch (e) {
      // Fallo la LLAMADA entera: red, credenciales, cola inexistente. Todas
      // las filas corren la misma suerte.
      const codigo = codigoDe(e);
      const detalle = mensajeDe(e);
      const ms = msDesde(t0);
      this.contadores.fallidos += filas.length;
      const items = filas.map((f) => ({ id: f.id, codigo, detalle }));
      return PERMANENTES.has(codigo)
        ? { ok: [], reintentar: [], permanentes: items, e6: new Date().toISOString(), ms }
        : { ok: [], reintentar: items, permanentes: [], e6: new Date().toISOString(), ms };
    }

    // El e6 se toma AQUI, cuando SQS ya contesto. Tomarlo antes del envio
    // metería la latencia de la cola dentro del tramo e5→e6 de C3.
    const e6 = new Date().toISOString();
    const ms = msDesde(t0);
    const ok: string[] = [];
    const reintentar: ResultadoEnvio['reintentar'] = [];
    const permanentes: ResultadoEnvio['permanentes'] = [];

    for (const s of r.Successful ?? []) {
      const f = porId.get(s.Id ?? '');
      if (f) ok.push(f.id);
    }
    for (const f of r.Failed ?? []) {
      const fila = porId.get(f.Id ?? '');
      if (!fila) continue;
      const codigo = f.Code ?? 'Desconocido';
      const detalle = f.Message ?? '';
      // `SenderFault` lo dice SQS: el problema es del mensaje, no suyo. Se
      // combina con la lista para no depender de una sola fuente.
      if (PERMANENTES.has(codigo) || f.SenderFault === true) {
        permanentes.push({ id: fila.id, codigo, detalle });
      } else {
        reintentar.push({ id: fila.id, codigo, detalle });
      }
    }

    this.contadores.ok += ok.length;
    this.contadores.fallidos += reintentar.length + permanentes.length;

    if (permanentes.length > 0) {
      this.logger.error(
        `⚠ ${permanentes.length} mensaje(s) a FAILED · ${permanentes[0]!.codigo} · ${permanentes[0]!.detalle}`,
      );
    }

    return { ok, reintentar, permanentes, e6, ms };
  }
}

function codigoDe(e: unknown): string {
  const x = e as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return x?.name ?? x?.Code ?? 'Desconocido';
}

function mensajeDe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
