import { Injectable } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import { BdService } from '../bd/bd.service';
import { ConsumidorService } from '../consumidor/consumidor.service';
import type { SaludDto, StatusDto } from './salud.dto';

/**
 * G-09 · lo que responde el health de C4.
 *
 * C4 sigue siendo un worker —la cola es su entrada y el Postgres su salida—,
 * pero necesita poder decir si SIGUE viendo su base. Un proceso vivo no dice
 * nada: con el Postgres caido, C4 seguiria sacando mensajes de la cola, los
 * borraria sin persistir y P4 daria de menos, sin un solo error en los logs.
 *
 * Por eso `ok` refleja LA BASE y no el proceso, igual que en C3 (C-08).
 */
@Injectable()
export class SaludService {
  constructor(
    private readonly config: ConfigService,
    private readonly bd: BdService,
    private readonly consumidor: ConsumidorService,
  ) {}

  /** Lo que responde `/health`. La consulta de verdad va aqui. */
  async salud(): Promise<SaludDto> {
    const base = await this.bd.viva();
    return {
      ok: base,
      base,
      rol: 'operador-neutro',
      // Escrito, no deducido: C4 descifra y verifica, pero NO firma (regla 7).
      // Lo sostienen las policies de KMS; decirlo aqui lo deja tambien a la
      // vista de cualquiera que mire el health.
      puede_firmar: false,
      esquema: this.config.bdEsquema,
      cola: this.config.colaUrl,
      dlq: this.config.dlqUrl,
      region: this.config.region,
      llaves_firma_aceptadas: this.config.llavesFirmaAceptadas.size,
      consumidor: this.consumidor.estado(),
    };
  }

  /** Contadores en memoria. No toca la base: es el lado barato. */
  estado(): StatusDto {
    return { rol: 'operador-neutro', consumidor: this.consumidor.estado() };
  }
}
