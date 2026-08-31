import {
  DeleteMessageBatchCommand,
  Message,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import { InboxRepository } from '../bd/inbox.repository';
import { DescifradorService } from '../cripto/descifrador.service';
import { VerificadorService } from '../cripto/verificador.service';
import { DlqService } from '../dlq/dlq.service';
import { ProcesadorService } from './procesador.service';

/**
 * G-01 · consumidor FIFO con long polling.
 *
 * Un lazo `while` con `await`, no un `setInterval`: con intervalo, dos ciclos
 * se solaparian en cuanto uno tarde mas que el periodo y el mismo mensaje se
 * procesaria dos veces por una razon que no es el contrato de
 * al-menos-una-vez, sino un bug propio.
 *
 * ⚠ Limite de 20.000 mensajes en vuelo en una cola FIFO. Si C4 se atrasa, la
 * cola deja de entregar con OverLimit y el sintoma PARECE que se vacio,
 * cuando en realidad esta llena.
 */
@Injectable()
export class ConsumidorService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('consumidor');
  private readonly sqs: SQSClient;
  private readonly abort = new AbortController();

  private corriendo = false;
  /**
   * Guarda de cierre, SEPARADA de `corriendo`.
   *
   * ⚠ Antes esta guarda era el propio `corriendo`, y eso era un bug: cuando
   * el lazo paraba por su cuenta -C4_SALIR_TRAS_VACIOS, o cualquier salida
   * limpia- `corriendo` ya estaba en false, asi que el cierre se creia hecho,
   * volvia sin limpiar nada y el intervalo del resumen dejaba vivo el event
   * loop para siempre. En Fargate el sintoma habria sido un contenedor que
   * ignora el SIGTERM y muere a los 30 s por SIGKILL, en medio de un lote.
   */
  private cerrado = false;
  private lazo: Promise<void> | null = null;
  private resumen: NodeJS.Timeout | null = null;
  private vaciosSeguidos = 0;

  /**
   * Se resuelve cuando el lazo para por si solo (C4_SALIR_TRAS_VACIOS).
   *
   * Existe para que una corrida acotada -una prueba, un drenado puntual-
   * pueda esperar el final sin sondear contadores desde fuera. En la corrida
   * normal nadie lo espera: el lazo no termina.
   */
  private terminar!: () => void;
  readonly terminado = new Promise<void>((r) => {
    this.terminar = r;
  });

  readonly contadores = {
    recibidos: 0,
    borrados: 0,
    fallos_borrado: 0,
    ciclos: 0,
    ciclos_vacios: 0,
    errores: 0,
    bytes: 0,
  };

  constructor(
    private readonly config: ConfigService,
    private readonly procesador: ProcesadorService,
    private readonly inbox: InboxRepository,
    private readonly descifrador: DescifradorService,
    private readonly verificador: VerificadorService,
    private readonly dlq: DlqService,
  ) {
    // Cliente en singleton. Uno por mensaje reabriria el pool de sockets en
    // cada vuelta y medirias el cliente, no la arquitectura.
    this.sqs = new SQSClient({ region: this.config.region });
  }

  onApplicationBootstrap(): void {
    this.corriendo = true;
    this.logger.log(
      `escuchando ${this.config.colaUrl} · region=${this.config.region} ` +
        `lote=${this.config.loteMax} espera=${this.config.esperaSegundos}s ` +
        `borrar=${this.config.borrar}`,
    );
    this.lazo = this.lazoPrincipal();
    this.resumen = setInterval(() => void this.emitirResumen(), this.config.resumenCadaMs);
  }

  /**
   * Fargate da 30 s tras el SIGTERM. Abortamos el ReceiveMessage en vuelo y
   * esperamos a que el ciclo actual termine: salir en medio deja mensajes
   * persistidos y no borrados, que reaparecen y se cuentan dos veces.
   */
  async onApplicationShutdown(senal?: string): Promise<void> {
    if (this.cerrado) return;
    this.cerrado = true;
    this.corriendo = false;
    this.logger.log(`cierre ordenado (${senal ?? 'sin senal'}) · drenando el ciclo en curso`);
    if (this.resumen) clearInterval(this.resumen);
    this.abort.abort();
    await this.lazo?.catch(() => undefined);
    this.sqs.destroy();
    await this.emitirResumen();
  }

  private async lazoPrincipal(): Promise<void> {
    let backoffMs = 0;

    while (this.corriendo) {
      try {
        const respuesta = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: this.config.colaUrl,
            MaxNumberOfMessages: this.config.loteMax,
            WaitTimeSeconds: this.config.esperaSegundos,
            // Sin esto no vuelven MessageGroupId ni MessageDeduplicationId,
            // que son los dos datos con los que C4 comprueba que el sobre por
            // fuera dice lo mismo que por dentro.
            MessageSystemAttributeNames: ['All'],
          }),
          { abortSignal: this.abort.signal },
        );

        backoffMs = 0;
        this.contadores.ciclos += 1;

        const mensajes = respuesta.Messages ?? [];
        if (mensajes.length === 0) {
          this.contadores.ciclos_vacios += 1;
          this.vaciosSeguidos += 1;
          if (
            this.config.salirTrasVaciosSeguidos > 0 &&
            this.vaciosSeguidos >= this.config.salirTrasVaciosSeguidos
          ) {
            this.logger.log(`${this.vaciosSeguidos} ciclos vacios seguidos · fin de la corrida`);
            this.corriendo = false;
          }
          continue;
        }
        this.vaciosSeguidos = 0;

        await this.procesarLote(mensajes);
      } catch (error) {
        if (!this.corriendo) break;
        this.contadores.errores += 1;
        // Sin backoff, una cola inexistente o un permiso faltante produce un
        // lazo caliente que quema la cuota de API de SQS -300/s por accion- y
        // llena CloudWatch con el mismo error miles de veces por minuto.
        backoffMs = Math.min(backoffMs === 0 ? 500 : backoffMs * 2, 10_000);
        this.logger.error(`ReceiveMessage fallo, reintento en ${backoffMs}ms: ${texto(error)}`);
        await dormir(backoffMs, this.abort.signal);
      }
    }

    this.logger.log('lazo detenido');
    this.terminar();
  }

  private async procesarLote(mensajes: Message[]): Promise<void> {
    // e7 · "C4 recibe el mensaje". Uno por mensaje pero el mismo instante
    // para todo el lote: llegaron juntos en la misma respuesta, y estamparlos
    // segun el orden en que se procesan le sumaria a e7 el tiempo de procesar
    // los anteriores — que ya se esta midiendo en e7→e10.
    const e7 = new Date();
    this.contadores.recibidos += mensajes.length;

    const aBorrar: Message[] = [];
    const e10s: Array<{ payloadHash: string; e10: Date }> = [];

    // En serie y no en paralelo: FIFO entrega en orden dentro de un grupo, y
    // procesar el lote concurrentemente lo perderia. Ademas el paralelismo
    // real de esta PoC son los 50 tenants, no los 10 mensajes de un lote.
    for (const mensaje of mensajes) {
      this.contadores.bytes += Buffer.byteLength(mensaje.Body ?? '', 'utf8');

      const r = await this.procesador.procesar(mensaje, e7);
      if (r.accion === 'borrar') aBorrar.push(mensaje);
      if (r.e10 && r.payloadHash) e10s.push({ payloadHash: r.payloadHash, e10: r.e10 });
    }

    // e10 del lote entero en una sentencia. El reloj ya paro para cada
    // evento -e10 se tomo justo despues de SU commit-, asi que agrupar la
    // escritura no mueve ningun numero.
    try {
      await this.inbox.estamparE10(e10s);
    } catch (e) {
      // No es fatal: la fila esta, el asiento esta, lo unico que falta es la
      // marca. Se avisa porque deja un agujero en P1, no en P4.
      this.logger.warn(`no se pudo estampar e10 de ${e10s.length} eventos: ${texto(e)}`);
    }

    if (this.config.borrar) await this.borrarLote(aBorrar);
  }

  /**
   * Borrado por lote, DESPUES de persistir. El orden importa: borrar antes de
   * procesar convierte la entrega en como-mucho-una-vez y una perdida dejaria
   * de verse en P4.
   */
  private async borrarLote(mensajes: Message[]): Promise<void> {
    const entradas = mensajes
      .filter((m) => m.ReceiptHandle !== undefined)
      .map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle as string }));
    if (entradas.length === 0) return;

    try {
      const respuesta = await this.sqs.send(
        new DeleteMessageBatchCommand({ QueueUrl: this.config.colaUrl, Entries: entradas }),
        // Sin abortSignal a proposito: si ya persistimos, queremos que el
        // borrado alcance a completarse durante el cierre.
      );
      this.contadores.borrados += respuesta.Successful?.length ?? 0;
      const fallidas = respuesta.Failed ?? [];
      if (fallidas.length > 0) {
        this.contadores.fallos_borrado += fallidas.length;
        this.logger.warn(
          `no se pudieron borrar ${fallidas.length} mensajes: ` +
            fallidas.map((f) => `${f.Id}:${f.Code}`).join(', '),
        );
      }
    } catch (error) {
      this.contadores.fallos_borrado += entradas.length;
      // No es fatal: el mensaje reaparece y el inbox lo absorbe como
      // duplicado. Para eso existe la idempotencia.
      this.logger.warn(`DeleteMessageBatch fallo: ${texto(error)}`);
    }
  }

  private async emitirResumen(): Promise<void> {
    const c = this.contadores;
    const p = this.procesador.contadores;
    const d = this.descifrador.contadores;
    const v = this.verificador.contadores;

    this.logger.log(
      `resumen · recibidos=${c.recibidos} persistidos=${p.persistidos} ` +
        `duplicados=${p.duplicados} descartados=${p.descartados} ` +
        `reintentar=${p.reintentar} borrados=${c.borrados} ` +
        `| kms: decrypt=${d.decrypt} (cache ${d.cache_hit}) pubkey=${v.get_public_key} ` +
        `| ciclos=${c.ciclos} vacios=${c.ciclos_vacios} errores=${c.errores} bytes=${c.bytes}`,
    );

    // La DLQ se MIRA, no se consume: leerla y borrarla destruiria la
    // evidencia para la que existe.
    const prof = await this.dlq.profundidad();
    if (prof !== null && prof > 0) {
      this.logger.warn(`⚠ la DLQ tiene ${prof} mensajes`);
    }
  }
}

function dormir(ms: number, senal: AbortSignal): Promise<void> {
  return new Promise((resolver) => {
    if (senal.aborted) return resolver();
    const temporizador = setTimeout(fin, ms);
    function fin(): void {
      clearTimeout(temporizador);
      senal.removeEventListener('abort', fin);
      resolver();
    }
    senal.addEventListener('abort', fin, { once: true });
  });
}

function texto(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
