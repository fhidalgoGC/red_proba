import { SendMessageCommand, SQSClient, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '../config/config.service';

export interface Envenenado {
  cuerpo: string;
  rpfId: string;
  payloadHash: string;
  messageId: string | null;
  motivo: string;
  detalle: string;
  e7: Date;
}

/**
 * G-07 · manejo de DLQ.
 *
 * Dos caminos, y la diferencia importa:
 *
 *  · Falla la PROYECCION (base caida, pool agotado) → C4 no hace nada: no
 *    borra el mensaje y deja que venza el visibility timeout. SQS lo
 *    reentrega y a la quinta recepcion el redrive_policy lo manda solo a la
 *    DLQ. Ese camino no pasa por este archivo.
 *
 *  · No DESCIFRA o no VERIFICA → veneno determinista: el mismo ciphertext con
 *    la misma llave va a fallar las cinco veces. Se manda a mano y se borra
 *    de la principal en el acto.
 *
 * ⚠ Por que a mano y no dejarlo al redrive automatico:
 *
 * `MessageGroupId = rpf_id`, y en FIFO un mensaje sin borrar BLOQUEA LA
 * CABEZA DE SU GRUPO. Dejar el veneno al redrive cuesta 5 recepciones x 60 s
 * de visibility = 5 minutos con toda la secuencia de ese expediente
 * congelada. Y G-05 reportaria un hueco que no es un hueco: un falso positivo
 * en la unica metrica que afirma que el orden se mantuvo.
 */
@Injectable()
export class DlqService implements OnApplicationShutdown {
  private readonly logger = new Logger('dlq');
  private readonly sqs: SQSClient;

  readonly contadores = { publicados: 0, fallidos: 0 };

  constructor(private readonly config: ConfigService) {
    this.sqs = new SQSClient({ region: this.config.region });
  }

  onApplicationShutdown(): void {
    this.sqs.destroy();
  }

  /** true si quedo evidencia en la cola. */
  async mandar(v: Envenenado): Promise<boolean> {
    if (!this.config.dlqUrl) return false;

    try {
      await this.sqs.send(
        new SendMessageCommand({
          QueueUrl: this.config.dlqUrl,
          MessageBody: v.cuerpo,
          // El redrive automatico conservaria grupo y dedup solo; mandando a
          // mano hay que reponerlos, o la DLQ FIFO rechaza el envio.
          MessageGroupId: v.rpfId,
          // ⚠ Se conserva el payload_hash original a proposito: si el mismo
          // veneno llega dos veces, el segundo envio a la DLQ se descarta en
          // silencio durante 5 minutos. Es lo deseable -no se duplica la
          // evidencia- pero implica que la PROFUNDIDAD de la DLQ no sirve
          // para contar. El conteo vive en la tabla `descartes`.
          MessageDeduplicationId: v.payloadHash,
          MessageAttributes: {
            // Metadatos de descarte, NO del payload: el payload va firmado y
            // meterle nada cambiaria lo que se firmo (regla 8). Estos van en
            // atributos, fuera del cuerpo.
            motivo: { DataType: 'String', StringValue: v.motivo },
            detalle: { DataType: 'String', StringValue: v.detalle.slice(0, 250) },
            message_id_original: { DataType: 'String', StringValue: v.messageId ?? 'desconocido' },
            e7: { DataType: 'String', StringValue: v.e7.toISOString() },
          },
        }),
      );
      this.contadores.publicados += 1;
      return true;
    } catch (e) {
      this.contadores.fallidos += 1;
      this.logger.error(`no se pudo publicar en la DLQ: ${String(e)}`);
      return false;
    }
  }

  /**
   * Profundidad de la DLQ. C4 la MIRA, no la consume: leer y borrar de la
   * DLQ destruiria justamente la evidencia para la que existe. Drenarla es
   * una herramienta aparte y manual.
   */
  async profundidad(): Promise<number | null> {
    if (!this.config.dlqUrl) return null;
    try {
      const r = await this.sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: this.config.dlqUrl,
          AttributeNames: ['ApproximateNumberOfMessages'],
        }),
      );
      return Number(r.Attributes?.ApproximateNumberOfMessages ?? 0);
    } catch {
      return null;
    }
  }
}
