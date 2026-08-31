import { randomUUID } from 'node:crypto';

/**
 * Hilos de expediente: quien decide el `rpf_id` y el `sequence`.
 *
 * Esta responsabilidad SE MUDO del contenedor del cliente al orquestador junto
 * con el generador, y es una mejora, no un efecto colateral:
 *
 *  - `rpf_id` es el MessageGroupId de la cola FIFO. Quien decide como se
 *    agrupan los eventos decide cuantos grupos ve SQS y, por lo tanto, si la
 *    prueba llega al techo de 300 msg/s por grupo (D-06). Antes esa decision
 *    estaba dentro de cada tenant, aislado y sin vision del conjunto.
 *
 *  - `sequence` es el orden dentro del expediente, y es lo que permite la
 *    deteccion de huecos. Con el orquestador llevando la cuenta, P4 deja de
 *    ser "conte 2.457 filas" y pasa a ser "estos ids salieron, estos
 *    llegaron, estos faltan".
 *
 * Cada tenant lleva su propio hilo: dos tenants nunca comparten un rpf_id,
 * igual que en el diseño real dos participantes nunca comparten expediente.
 */
export class Hilos {
  private rpfId = randomUUID();
  private sequence = 0;
  private emitidosEnHilo = 0;

  constructor(private readonly eventosPorHilo: number) {
    if (eventosPorHilo < 1) throw new Error('eventos_por_hilo debe ser >= 1');
  }

  /** Siguiente par (rpf_id, sequence). Rota el hilo cuando toca. */
  siguiente(): { rpfId: string; sequence: number } {
    if (this.emitidosEnHilo >= this.eventosPorHilo) {
      this.rpfId = randomUUID();
      this.sequence = 0;
      this.emitidosEnHilo = 0;
    }
    this.emitidosEnHilo++;
    this.sequence++;
    return { rpfId: this.rpfId, sequence: this.sequence };
  }
}
