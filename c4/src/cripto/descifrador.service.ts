import { DecryptCommand, KMSClient } from '@aws-sdk/client-kms';
import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import { abrir, type Contenido, type Sobre } from '../comun/sobre';

/** Data keys distintas vivas a la vez. C3 reusa una por lote: con 64 sobra. */
const MAX_CACHE = 64;

/**
 * G-02, primer paso · descifrado.
 *
 * C4 descifra y NUNCA firma (regla 7). Ese invariante no lo sostiene este
 * archivo: lo sostiene la policy de KMS. Aqui solo esta la mitad que a C4 le
 * corresponde poder hacer.
 */
@Injectable()
export class DescifradorService implements OnApplicationShutdown {
  private readonly logger = new Logger('descifrador');
  private readonly kms: KMSClient;

  /**
   * Data keys ya descifradas, por `edk`.
   *
   * C3 pide una data key por lote y la reusa (C-04), asi que sin cache C4
   * gastaria un `Decrypt` por MENSAJE para obtener N veces la misma clave.
   * Con cache es uno por lote. La llamada a KMS ronda los 20-40 ms: sin esto,
   * el tramo e7→e8 mediria la latencia de KMS en vez del descifrado, y el
   * consumidor se toparia antes con la cuota de KMS que con la de la cola.
   */
  private readonly cache = new Map<string, Buffer>();

  readonly contadores = { decrypt: 0, cache_hit: 0, descifrados: 0, fallos: 0 };

  constructor(private readonly config: ConfigService) {
    this.kms = new KMSClient({ region: this.config.region });
  }

  onApplicationShutdown(): void {
    this.kms.destroy();
    // Las data keys en claro se van con el proceso igual, pero borrarlas a
    // mano deja dicho que son material sensible y no un cache cualquiera.
    for (const [k, v] of this.cache) {
      v.fill(0);
      this.cache.delete(k);
    }
  }

  async descifrar(sobre: Sobre): Promise<Contenido> {
    const dataKey = await this.dataKey(sobre.edk);
    try {
      const c = abrir(sobre, dataKey);
      this.contadores.descifrados += 1;
      return c;
    } catch (e) {
      this.contadores.fallos += 1;
      // El tag de GCM no cuadro. NO es corrupcion en transito -SQS tiene su
      // propia integridad de extremo a extremo-: es manipulacion o llave
      // equivocada. Va a la DLQ con alarma (G-07), no al reintento.
      throw new Error(`el sobre no abre: ${mensaje(e)}`);
    }
  }

  private async dataKey(edk: string): Promise<Buffer> {
    const enCache = this.cache.get(edk);
    if (enCache) {
      this.contadores.cache_hit += 1;
      // Reinsertar para que el orden del Map sea el de uso: el primero que
      // sale al desalojar es el menos usado recientemente, no el mas viejo.
      this.cache.delete(edk);
      this.cache.set(edk, enCache);
      return enCache;
    }

    const r = await this.kms.send(
      new DecryptCommand({
        CiphertextBlob: Buffer.from(edk, 'base64'),
        // Explicito aunque la policy de C4 ya solo permita esta llave: sin
        // KeyId, KMS descifra con la llave que diga el propio blob y un blob
        // de otra llave daria AccessDenied, que no distingue "no tengo
        // permiso" de "esto no es mio".
        ...(this.config.llaveMensajes ? { KeyId: this.config.llaveMensajes } : {}),
      }),
    );
    this.contadores.decrypt += 1;

    const clave = Buffer.from(r.Plaintext as Uint8Array);
    if (clave.length !== 32) {
      throw new Error(`la data key mide ${clave.length} bytes, AES-256 pide 32`);
    }

    if (this.cache.size >= MAX_CACHE) {
      const viejo = this.cache.keys().next().value as string | undefined;
      if (viejo !== undefined) {
        this.cache.get(viejo)?.fill(0);
        this.cache.delete(viejo);
      }
    }
    this.cache.set(edk, clave);
    return clave;
  }
}

function mensaje(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
