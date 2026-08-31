/**
 * `party_id` — el pseudonimo HMAC del participante. Paso ② del pipeline RPF.
 *
 * El orquestador manda un placeholder de largo fijo y C3 lo sustituye por
 * esto. La llave de pseudonimizacion vive en el KMS de C3 y NUNCA sale del
 * dominio del participante: C4 agrupa por `party_id` sin poder saber a que
 * tenant corresponde (D-08).
 *
 * ⚠ SE CALCULA UNA VEZ, AL ARRANCAR. Es `HMAC(tenant_id)` y el tenant_id de
 * un contenedor no cambia: pedirselo a KMS por evento serian 2.000 llamadas
 * por segundo a una cuota que la firma ya necesita entera, para obtener
 * siempre el mismo string. Una llamada, cacheada de por vida del proceso.
 */
import { GenerateMacCommand, KMSClient } from '@aws-sdk/client-kms';
import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import { PARTY_ID_LARGO, PARTY_ID_PREFIJO } from '../mapper/contrato';
import { partyIdLocal } from '../mapper/hashing';

@Injectable()
export class PseudonimoService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('pseudonimo');
  private readonly kms: KMSClient | null;
  private ref: string | null = null;

  constructor(private readonly config: ConfigService) {
    this.kms = config.modoLocal ? null : new KMSClient({ region: config.region });
  }

  async onModuleInit(): Promise<void> {
    this.ref = await this.calcular();
    if (this.ref.length !== PARTY_ID_LARGO) {
      throw new Error(`el party_id quedo en ${this.ref.length} caracteres, se esperaban ${PARTY_ID_LARGO}`);
    }
    this.logger.log(`party_id de '${this.config.tenantId}' = ${this.ref}`);
  }

  onApplicationShutdown(): void {
    this.kms?.destroy();
  }

  /** El pseudonimo ya calculado. Sincrono a proposito: el mapper es puro. */
  get partyId(): string {
    if (this.ref === null) {
      throw new Error('el party_id todavia no se calculo; onModuleInit no corrio');
    }
    return this.ref;
  }

  private async calcular(): Promise<string> {
    if (this.kms === null || this.config.llaveHmac === null) {
      return PARTY_ID_PREFIJO + partyIdLocal(this.config.tenantId);
    }

    const r = await this.kms.send(
      new GenerateMacCommand({
        KeyId: this.config.llaveHmac,
        MacAlgorithm: 'HMAC_SHA_256',
        Message: Buffer.from(this.config.tenantId, 'utf8'),
      }),
    );
    if (!r.Mac) throw new Error('KMS GenerateMac no devolvio Mac');

    // HMAC_SHA_256 da 32 bytes = 64 hex, y va COMPLETO: el contrato fija 64.
    //
    // El largo no es negociable en ninguna direccion. El orquestador ajusta el
    // `padding` al byte contra un placeholder de 69 caracteres; un party_id de
    // otro largo correria el tamano canonico de TODOS los eventos de este
    // tenant, y los bytes que reportan los dos lados dejarian de cuadrar.
    return PARTY_ID_PREFIJO + Buffer.from(r.Mac).toString('hex');
  }
}
