/**
 * C-04 · Cifrado con cache de data key.
 *
 * AES-256-GCM sobre `{ payload, signature }`. La data key sale de
 * `GenerateDataKey` sobre la llave SIMETRICA DE C4 — C3 puede pedirla pero no
 * puede descifrar nada con esa llave, que es el otro lado de la regla 7.
 *
 * ⚠ SE FIRMA PRIMERO Y SE CIFRA DESPUES (regla 6). La firma cubre el
 * documento, no un ciphertext que cualquiera podria rehacer. Por eso la firma
 * viaja DENTRO del sobre, cifrada junto al payload, y no como un campo en
 * claro al lado.
 *
 * ⚠ UNA DATA KEY POR LOTE, NO POR EVENTO. `GenerateDataKey` es simetrica
 * ($0.03/10k) y aguanta mucho mas throughput que la firma, pero pedirla por
 * evento duplicaria el trafico a KMS sin comprar nada: la misma data key cifra
 * N sobres con un IV distinto cada uno, y ahi es donde esta la seguridad. Del
 * otro lado C4 cachea por `edk`, asi que reusarla tambien le ahorra a el un
 * `Decrypt` por mensaje.
 */
import { GenerateDataKeyCommand, KMSClient } from '@aws-sdk/client-kms';
import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { ConfigService } from '../config/config.service';
import { sellar, type Contenido, type Sobre } from '../comun/sobre';

/** Una data key viva y cuantos eventos le quedan. */
interface Vigente {
  clara: Buffer;
  cifrada: Buffer;
  usos: number;
}

@Injectable()
export class CifradorService implements OnApplicationShutdown {
  private readonly kms: KMSClient | null;
  private vigente: Vigente | null = null;

  /**
   * La renovacion en vuelo, compartida.
   *
   * Sin esto, N peticiones concurrentes que llegan con la data key agotada
   * disparan N `GenerateDataKey` a la vez — justo bajo la rafaga, que es
   * cuando menos conviene. Con la promesa compartida, la primera pide y las
   * demas esperan esa misma.
   */
  private renovando: Promise<Vigente> | null = null;

  readonly contadores = { generate_data_key: 0, reusos: 0, cifrados: 0 };

  constructor(private readonly config: ConfigService) {
    this.kms = config.modoLocal ? null : new KMSClient({ region: config.region });
  }

  onApplicationShutdown(): void {
    this.kms?.destroy();
    // Material sensible: se borra a mano aunque el proceso se lo lleve igual.
    this.vigente?.clara.fill(0);
    this.vigente = null;
  }

  /**
   * @param payload el documento canonizado, con el party_id real
   * @param firma   base64, de C-03
   * @param keyId   ARN de la llave de FIRMA; C4 lo usa para verificar
   */
  async cifrar(payload: Record<string, unknown>, firma: string, keyId: string): Promise<Sobre> {
    const dk = await this.dataKey();
    const contenido: Contenido = { payload, signature: firma };
    const sobre = sellar(contenido, dk.clara, dk.cifrada, keyId);
    this.contadores.cifrados += 1;
    return sobre;
  }

  private async dataKey(): Promise<Vigente> {
    const v = this.vigente;
    if (v !== null && v.usos > 0) {
      v.usos -= 1;
      this.contadores.reusos += 1;
      return v;
    }
    if (this.renovando !== null) return this.renovando;

    this.renovando = this.generar()
      .then((nueva) => {
        this.vigente?.clara.fill(0);
        this.vigente = nueva;
        return nueva;
      })
      .finally(() => {
        // En `finally` y no al final del `then`: si `generar` falla, dejar la
        // promesa colgada congelaria el cifrado para siempre y el sintoma
        // seria un contenedor vivo que no publica nada. Mismo razonamiento
        // que el `finally` del relay en C-06.
        this.renovando = null;
      });

    return this.renovando;
  }

  private async generar(): Promise<Vigente> {
    const usos = this.config.eventosPorDataKey - 1;

    if (this.kms === null || this.config.llaveCifrado === null) {
      // Modo local: una data key de 32 bytes que C4 no puede descifrar, porque
      // su `edk` no salio de KMS. Va marcada para que el fallo se lea.
      return {
        clara: randomBytes(32),
        cifrada: Buffer.from(`local:no-es-una-edk:${randomBytes(8).toString('hex')}`, 'utf8'),
        usos,
      };
    }

    const r = await this.kms.send(
      new GenerateDataKeyCommand({
        KeyId: this.config.llaveCifrado,
        KeySpec: 'AES_256',
      }),
    );
    if (!r.Plaintext || !r.CiphertextBlob) {
      throw new Error('KMS GenerateDataKey no devolvio la data key completa');
    }
    this.contadores.generate_data_key += 1;
    return {
      clara: Buffer.from(r.Plaintext),
      cifrada: Buffer.from(r.CiphertextBlob),
      usos,
    };
  }
}
