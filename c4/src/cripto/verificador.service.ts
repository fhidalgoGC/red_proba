import { GetPublicKeyCommand, KMSClient } from '@aws-sdk/client-kms';
import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import { ConfigService } from '../config/config.service';
import { canonicalize } from '../comun/jcs';

export class LlaveNoAceptada extends Error {}
export class FirmaInvalida extends Error {}

/**
 * G-02, segundo paso · verificacion de la firma Ed25519.
 *
 * ⚠ La verificacion es LOCAL, no `kms:Verify`.
 *
 * Dos razones, y la segunda es la importante:
 *
 *  1. `Verify` es una llamada de red por evento (~30 ms) y una cuota
 *     compartida con la firma de los 50 tenants. C4 se saturaria en KMS
 *     antes que en cualquier componente que la PoC quiere medir, y P3
 *     responderia "el limite es KMS" por un motivo que es de implementacion.
 *  2. La llave publica es publica. Bajarla una vez y verificar en proceso da
 *     exactamente la misma garantia criptografica — y deja por escrito que
 *     C4 solo necesita `GetPublicKey`, nunca `Sign`. El invariante de la
 *     regla 7 se vuelve visible en el codigo, no solo en la policy.
 */
@Injectable()
export class VerificadorService implements OnApplicationShutdown {
  private readonly logger = new Logger('verificador');
  private readonly kms: KMSClient;
  private readonly llaves = new Map<string, KeyObject>();
  private readonly pidiendo = new Map<string, Promise<KeyObject>>();

  readonly contadores = { get_public_key: 0, verificadas: 0, invalidas: 0, rechazadas: 0 };

  constructor(private readonly config: ConfigService) {
    this.kms = new KMSClient({ region: this.config.region });
  }

  onApplicationShutdown(): void {
    this.kms.destroy();
  }

  /**
   * Verifica que `firma` cubre el canonico de `payload`.
   *
   * Se recanoniza aqui en vez de confiar en unos bytes que vinieran en el
   * sobre: firmar sobre lo que el emisor DICE que canonizo, y no sobre lo que
   * uno mismo canoniza a partir del objeto que va a guardar, dejaria un hueco
   * por el que el payload persistido podria no ser el firmado.
   */
  async verificar(
    payload: Record<string, unknown>,
    firmaB64: string,
    keyId: string,
  ): Promise<{ canonico: Buffer }> {
    // ⚠ La lista blanca va ANTES de mirar la firma.
    //
    // `key_id` viaja en el sobre y lo escribio quien publico. Si C4 fuera a
    // buscar la llave que el mensaje pide, cualquiera con permiso de publicar
    // podria firmar con SU llave, poner su ARN, y la firma verificaria
    // perfectamente. Verificar sin lista blanca prueba integridad; solo con
    // lista blanca prueba autoria.
    if (this.config.llavesFirmaAceptadas.size > 0 && !this.config.llavesFirmaAceptadas.has(keyId)) {
      this.contadores.rechazadas += 1;
      throw new LlaveNoAceptada(`key_id no esta en la lista blanca: ${keyId}`);
    }

    const publica = await this.llavePublica(keyId);
    const canonico = Buffer.from(canonicalize(payload), 'utf8');
    const firma = Buffer.from(firmaB64, 'base64');

    // `verify(null, ...)`: Ed25519 puro. El algoritmo de hash va dentro del
    // esquema -SHA-512-, no se pasa aparte. Es lo que KMS llama
    // ED25519_SHA_512 al firmar con MessageType RAW.
    const ok = verify(null, canonico, publica, firma);
    if (!ok) {
      this.contadores.invalidas += 1;
      throw new FirmaInvalida(
        `la firma no verifica sobre ${canonico.length} bytes canonicos (key_id=${keyId})`,
      );
    }

    this.contadores.verificadas += 1;
    return { canonico };
  }

  private async llavePublica(keyId: string): Promise<KeyObject> {
    const ya = this.llaves.get(keyId);
    if (ya) return ya;

    // Una sola descarga aunque lleguen N mensajes juntos con la misma llave.
    const enVuelo = this.pidiendo.get(keyId);
    if (enVuelo) return enVuelo;

    const p = this.descargar(keyId).finally(() => this.pidiendo.delete(keyId));
    this.pidiendo.set(keyId, p);
    return p;
  }

  private async descargar(keyId: string): Promise<KeyObject> {
    const r = await this.kms.send(new GetPublicKeyCommand({ KeyId: keyId }));
    this.contadores.get_public_key += 1;

    if (r.KeySpec !== 'ECC_NIST_EDWARDS25519') {
      throw new LlaveNoAceptada(`${keyId} es ${String(r.KeySpec)}, no Ed25519`);
    }

    const llave = createPublicKey({
      key: Buffer.from(r.PublicKey as Uint8Array),
      format: 'der',
      type: 'spki',
    });
    this.llaves.set(keyId, llave);
    this.logger.log(`llave publica en cache: ${keyId} (${r.KeySpec})`);
    return llave;
  }
}
