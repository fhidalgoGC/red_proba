/**
 * C-03 · Signer. KMS `Sign` con Ed25519.
 *
 * ⚠ ES EL CUELLO DE BOTELLA, y la PoC existe en buena parte para medirlo (P3).
 * Todo lo que hay aqui esta puesto para que lo que se mida sea KMS y no una
 * torpeza de implementacion:
 *
 *  - Cliente del SDK en SINGLETON. Uno por peticion añade el handshake TLS a
 *    cada evento; a 2.000 ev/s eso no es ruido, es la medicion entera.
 *  - Se firma el CANONICO, no un hash del canonico. Ed25519 puro (`Ed25519`,
 *    no `Ed25519ph`) hace el SHA-512 por dentro. C4 verifica con
 *    `verify(null, canonico, ...)`, que es la misma convencion: si aqui se
 *    firmara un digest, alli no verificaria nada.
 *  - No hay reintento propio. El SDK ya reintenta lo reintentable, y un
 *    reintento a mano falsearia el tramo e1→e2 sumando esperas que no son de
 *    la firma.
 *
 * ⚠ EL INVARIANTE: C3 firma y NUNCA descifra (regla 7). No lo sostiene este
 * archivo, lo sostienen las policies de KMS. Aqui solo esta la mitad que le
 * toca.
 */
import { KMSClient, SignCommand } from '@aws-sdk/client-kms';
import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { ConfigService } from '../config/config.service';

export interface Firma {
  /** La firma en base64. Viaja DENTRO del sobre, cifrada con el payload. */
  firma: string;
  /** ARN de la llave. C4 lo lee del sobre para saber con cual verificar. */
  keyId: string;
}

@Injectable()
export class FirmadorService implements OnApplicationShutdown {
  private readonly kms: KMSClient | null;
  /** Solo en modo local. En KMS la privada no existe de este lado. */
  private readonly privadaLocal: KeyObject | null;
  private readonly keyIdLocal: string;

  readonly contadores = { firmadas: 0, fallos: 0 };

  constructor(private readonly config: ConfigService) {
    if (config.modoLocal) {
      this.kms = null;
      this.privadaLocal = generateKeyPairSync('ed25519').privateKey;
      // Se marca en el propio key_id que esto NO es KMS: si un sobre asi
      // llegara a la cola de verdad, el motivo del descarte se lee de una
      // ojeada en vez de aparecer como un ARN que nadie reconoce.
      this.keyIdLocal = `local:ed25519:${config.tenantId}`;
    } else {
      this.kms = new KMSClient({ region: config.region });
      this.privadaLocal = null;
      this.keyIdLocal = '';
    }
  }

  onApplicationShutdown(): void {
    this.kms?.destroy();
  }

  /** @param canonico exactamente lo que salio del mapper, sin re-serializar */
  async firmar(canonico: Buffer): Promise<Firma> {
    if (this.kms === null || this.config.llaveFirma === null) {
      // `sign(null, ...)`: Ed25519 puro, igual que la verificacion de C4.
      const firma = sign(null, canonico, this.privadaLocal!);
      this.contadores.firmadas += 1;
      return { firma: firma.toString('base64'), keyId: this.keyIdLocal };
    }

    try {
      const r = await this.kms.send(
        new SignCommand({
          KeyId: this.config.llaveFirma,
          Message: canonico,
          // RAW y no DIGEST: `ED25519_SHA_512` exige RAW y hace el SHA-512
          // por dentro. La variante `ED25519_PH_SHA_512` es la que pide
          // DIGEST — y produce firmas que la verificacion Ed25519 pura de C4
          // rechazaria, porque no es el mismo esquema.
          MessageType: 'RAW',
          SigningAlgorithm: 'ED25519_SHA_512',
        }),
      );
      if (!r.Signature) throw new Error('KMS Sign no devolvio Signature');
      this.contadores.firmadas += 1;
      return {
        firma: Buffer.from(r.Signature).toString('base64'),
        // El ARN que devuelve KMS, no el de la config: si la config trae un
        // alias, C4 recibiria un key_id que no coincide con ninguna entrada de
        // su lista blanca y rechazaria firmas perfectamente validas.
        keyId: r.KeyId ?? this.config.llaveFirma,
      };
    } catch (e) {
      this.contadores.fallos += 1;
      throw e;
    }
  }

  /**
   * La llave publica del modo local, para que un test pueda verificar lo que
   * se firmo sin salir del proceso. En modo KMS devuelve null: la publica se
   * baja con `GetPublicKey`, y eso es cosa de C4.
   */
  publicaLocal(): KeyObject | null {
    return this.privadaLocal === null ? null : createPublicKey(this.privadaLocal);
  }
}
