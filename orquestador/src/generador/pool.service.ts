import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '../config/config.service';
import type { Pool } from '../config/tipos';
import { bytesCanonicos } from './jcs';
import {
  construirPlantilla,
  prng,
  relleno,
  PARTY_ID_LARGO,
  PARTY_ID_PLACEHOLDER,
  type Documento,
  type Plantilla,
} from './payload';

/** Un documento listo para enviar, con su tamaño canonico ya conocido. */
export interface DocumentoListo {
  doc: Documento;
  bytes: number;
}

/**
 * Pool de payloads pre-generados.
 *
 * POR QUE UN POOL: generar un documento completo cuesta construir ~52
 * atributos, hacer la aritmetica en centavos y canonizar el evento dos veces
 * para ajustar el relleno. A 2.000-3.000 eventos/s eso convierte al
 * orquestador en el cuello de botella, y entonces la prueba mide el generador
 * en vez de la arquitectura. Se paga una vez al arrancar y despues cada envio
 * es una sustitucion de campos.
 *
 * ────────────────────────────────────────────────────────────────────────
 * LA TRAMPA QUE ESTO EVITA
 *
 * Reusar una plantilla TAL CUAL seria un error grave, no una optimizacion.
 * `MessageDeduplicationId` es el sha256 del payload canonico EN CLARO
 * (docs/02-payload.md). Dos envios del mismo documento producen el mismo
 * payload_hash, y SQS FIFO descarta el segundo EN SILENCIO durante su ventana de
 * 5 minutos. Perderias la mayor parte de los eventos y P4 daria un falso
 * negativo masivo, sin un solo error en los logs.
 *
 * Por eso cada envio refresca los campos de identidad — event_id, rpf_id,
 * sequence, occurred_at — y con eso el canonico, y por lo tanto el payload_hash,
 * es unico.
 * ────────────────────────────────────────────────────────────────────────
 *
 * EL INVARIANTE DE TAMAÑO SOBREVIVE porque todos los campos que se sustituyen
 * son de largo fijo:
 *
 *   rpf_id, event_id   UUID           36 caracteres
 *   occurred_at        ISO-8601       24 caracteres
 *   party_id           'hmac:'+64hex  69 caracteres
 *   sequence           entero         VARIABLE  ← el unico
 *
 * `sequence` es el unico que cambia de largo, y su delta es exactamente la
 * diferencia de digitos. Se compensa recortando o alargando `padding`, que es
 * O(1) y no requiere re-canonizar. Cada plantilla conserva SU tamaño objetivo
 * — el pool es de tamaño variado, no fijo — y ese es el numero contra el que
 * se verifica.
 */
@Injectable()
export class PoolService implements OnModuleInit {
  private readonly logger = new Logger(PoolService.name);

  private plantillas: Plantilla[] = [];
  /** Largo en caracteres del `sequence` de cada plantilla. Se lee del dato en
   *  vez de asumirse, para que el delta siga siendo correcto si la plantilla
   *  cambia algun dia. */
  private digitosSeq: number[] = [];
  /**
   * Flujos SEPARADOS a proposito.
   *
   * `elegir` sortea que plantilla se manda. `muestrear` decide si a este
   * evento le toca verificacion de tamaño. Si compartieran un solo flujo, cada
   * llamada a tomar() consumiria uno o dos numeros segun `tasa_verificacion`
   * — y entonces cambiar la tasa de verificacion cambiaria QUE PLANTILLAS SE
   * ENVIAN. Dos corridas con la misma semilla y distinta tasa dejarian de ser
   * comparables, por un parametro que solo deberia afectar al diagnostico.
   *
   * La regla: un consumidor, un flujo. Compartir flujo acopla cosas que no
   * tienen nada que ver, y el acoplamiento es invisible.
   */
  private elegir!: () => number;
  private muestrear!: () => number;
  private verificados = 0;
  private _bytesTotales = 0;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    this.construir(this.config.perfil.pool);
  }

  /**
   * Reconstruye el pool con otros parametros.
   *
   * Cuesta ~40 ms para 1.000 plantillas, asi que una corrida puede pedir otra
   * semilla o otro rango de tamaños sin reiniciar el contenedor. Solo se llama
   * cuando algo del pool cambio de verdad: reconstruirlo sin motivo cambiaria
   * el relleno entre corridas que deberian salir identicas.
   */
  reconstruir(pool: Pool): void {
    this.construir(pool);
  }

  private construir(cfg: Pool): void {
    const { plantillas: n, semilla, tamanoBytes, itemsPorDocumento } = cfg;
    this._bytesTotales = 0;
    this.verificados = 0;

    const t0 = process.hrtime.bigint();
    const r = prng(semilla);

    const lista: Plantilla[] = new Array(n);
    const digitos: number[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const p = construirPlantilla(i, r, { tamanoBytes, itemsPorDocumento });
      lista[i] = p;
      digitos[i] = String(p.doc.sequence).length;
      this._bytesTotales += p.bytes;
    }
    this.plantillas = lista;
    this.digitosSeq = digitos;

    // Seleccion tambien determinista: con la misma semilla, la misma
    // secuencia de plantillas. Ayuda a reproducir una corrida.
    this.elegir = prng(semilla ^ 0x5f3759df);
    this.muestrear = prng(semilla ^ 0x2545f491);

    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const d = this.distribucion();
    this.logger.log(
      `pool listo: ${n} plantillas en ${ms.toFixed(0)} ms · ` +
      `tamaño ${d.min}-${d.max} B (media ${d.media}) · ` +
      `${(this._bytesTotales / 1024 / 1024).toFixed(1)} MB canonicos en memoria`,
    );
  }

  get tamano(): number { return this.plantillas.length; }
  get muestrasVerificadas(): number { return this.verificados; }

  /** Estadisticos del pool, para /status. Con tamaño variado hay que poder
   *  ver que la variacion es la que se pidio. */
  distribucion(): { min: number; max: number; media: number; p50: number; p95: number } {
    const b = this.plantillas.map((p) => p.bytes).sort((a, c) => a - c);
    if (b.length === 0) return { min: 0, max: 0, media: 0, p50: 0, p95: 0 };
    const pct = (p: number) => b[Math.min(b.length - 1, Math.floor((p / 100) * b.length))]!;
    return {
      min: b[0]!,
      max: b[b.length - 1]!,
      media: Math.round(b.reduce((a, c) => a + c, 0) / b.length),
      p50: pct(50),
      p95: pct(95),
    };
  }

  /**
   * Un documento listo para enviar: contenido reusado, identidad fresca.
   *
   * `partyId` viaja como el placeholder de largo fijo que C3 sustituira por
   * el HMAC real de KMS cuando exista. Ver payload.ts.
   */
  /**
   * Sortea el indice de una plantilla, sin materializarla.
   *
   * Lo usa el planificador para armar el PLAN de toda la corrida por delante:
   * el plan solo guarda indices, que son un numero, en vez de documentos de
   * 2 KB. Materializar los 25 millones de eventos de una corrida larga no
   * cabria en memoria; guardar 25 millones de enteros, si.
   */
  sortearIndice(): number {
    return Math.floor(this.elegir() * this.plantillas.length);
  }

  /** Materializa la plantilla `idx`. Ver `tomar` para el detalle. */
  materializar(idx: number, rpfId: string, sequence: number, partyId: string = PARTY_ID_PLACEHOLDER): DocumentoListo {
    return this.desde(idx, rpfId, sequence, partyId);
  }

  tomar(rpfId: string, sequence: number, partyId: string = PARTY_ID_PLACEHOLDER): DocumentoListo {
    return this.desde(this.sortearIndice(), rpfId, sequence, partyId);
  }

  private desde(idx: number, rpfId: string, sequence: number, partyId: string): DocumentoListo {
    if (partyId.length !== PARTY_ID_LARGO) {
      // Si esto se dispara, el documento dejaria de pesar lo que dice pesar y
      // toda la comparacion de la prueba quedaria invalidada. Fallar ruidoso.
      throw new Error(
        `party_id debe medir ${PARTY_ID_LARGO} caracteres para no mover el ` +
        `tamaño canonico; vino uno de ${partyId.length}`,
      );
    }

    const base = this.plantillas[idx]!;

    // Delta de tamaño: solo lo aporta `sequence`.
    const delta = String(sequence).length - this.digitosSeq[idx]!;
    let padding = base.doc.padding;
    if (delta > 0) {
      if (padding.length < delta) {
        throw new Error(
          `sequence=${sequence} no cabe: el relleno de la plantilla ${idx} mide ` +
          `${padding.length} y hacen falta ${delta}. Sube pool.tamano_bytes.`,
        );
      }
      padding = padding.slice(0, padding.length - delta);
    } else if (delta < 0) {
      padding = padding + relleno(-delta);
    }

    const doc: Documento = {
      ...base.doc,
      rpf_id: rpfId,
      event_id: randomUUID(),
      occurred_at: new Date().toISOString(),
      sequence,
      party_id: partyId,
      padding,
    };

    this.verificarMuestra(doc, base.bytes);
    return { doc, bytes: base.bytes };
  }

  /**
   * Verificacion muestreada del invariante de tamaño.
   *
   * Canonizar cada evento a ritmo alto cuesta lo mismo que generarlo, y
   * anularia el pool. Pero no verificar NUNCA significa que un error de
   * aritmetica del delta pasaria inadvertido hasta que C3 rechace las firmas
   * — y ahi el sintoma no se parece en nada a la causa.
   * El muestreo es el termino medio: `pool.tasa_verificacion` en el perfil.
   */
  private verificarMuestra(doc: Documento, esperados: number): void {
    const tasa = this.config.perfil.pool.tasaVerificacion;
    if (tasa <= 0) return;
    if (tasa < 1 && this.muestrear() >= tasa) return;

    const real = bytesCanonicos(doc);
    if (real !== esperados) {
      throw new Error(
        `invariante de tamaño roto: el evento ${doc.event_id} mide ${real} bytes ` +
        `canonicos y su plantilla declara ${esperados} (sequence=${doc.sequence})`,
      );
    }
    this.verificados++;
  }
}
