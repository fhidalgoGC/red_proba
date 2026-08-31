/**
 * El pipeline de C3, hasta donde llega hoy.
 *
 *   documento del orquestador
 *     → C-02  validar + party_id + canonizar
 *     → ②     payload_hash (SHA-256) + party_id (HMAC-SHA256)
 *     → C-03  firmar Ed25519
 *     → C-04  cifrar { payload, signature }
 *     → C-05  ESCRIBIR EL OUTBOX, en la transaccion de negocio
 *     → [ AQUI SE CORTA ]
 *
 * ⚠ LO QUE FALTA: el relay (C-06). La fila queda en el outbox con
 * `status='PENDING'` y nadie la publica todavia, asi que HOY NADA LLEGA A C4
 * — pero ya no se pierde: esta escrita y esperando.
 *
 * ⚠ EL COMMIT VA ANTES DE PUBLICAR, y por eso el orden de este archivo no es
 * negociable (regla 3). Cuando exista C-06, la publicacion NO se añade aqui:
 * se hace desde el relay, leyendo el outbox. Publicar dentro de la
 * transaccion daria el caso «se publico y luego el commit fallo» — un evento
 * en la cola que no existe en tu base.
 *
 * Las marcas e0..e3 se toman aqui porque es donde ocurren los tramos, y se
 * escriben en COLUMNAS de la fila del outbox (C-09). Nunca dentro del payload
 * — el payload va firmado, y meterle metadatos de medicion cambiaria lo que
 * se firma (regla 8).
 */
import { Injectable, Logger } from '@nestjs/common';
import { CifradorService } from '../cripto/cifrador.service';
import { FirmadorService } from '../cripto/firmador.service';
import { PseudonimoService } from '../cripto/pseudonimo.service';
import { OutboxRepository } from '../bd/outbox.repository';
import { DocumentoInvalido, MapperService } from '../mapper/mapper.service';
import type { Sobre } from '../comun/sobre';

/** Un documento que recorrio el pipeline entero. */
export interface Procesado {
  rpfId: string;
  eventId: string;
  sequence: number;
  /** SHA-256 del canonico (paso ②). MessageDeduplicationId y PK del inbox. */
  payloadHash: string;
  /** HMAC-SHA256 del participante (paso ②). */
  partyId: string;
  /** Bytes canonicos del payload en claro. */
  bytesCanonicos: number;
  /** Bytes del sobre serializado: lo que de verdad pesaria en la cola. */
  bytesSobre: number;
  sobre: Sobre;
  /** Marcas de C-09. Su destino son las columnas del outbox. */
  marcas: Marcas;
  /** `id` de la fila del outbox. Se rellena tras el COMMIT de C-05. */
  outboxId?: string;
}

/**
 * e0..e3. Faltan e4 (commit), e5 (reclamo) y e6 (publicacion), que son de
 * C-05 y C-06.
 */
export interface Marcas {
  /** C3 recibio el documento y lo entrega al mapper. */
  e0: string;
  /** Canonizado. */
  e1: string;
  /** KMS Sign devolvio. */
  e2: string;
  /** Cifrado. */
  e3: string;
  /** COMMIT de la transaccion de negocio. Lo pone la base (C-05). */
  e4?: string;
}

/** Un documento que no paso. Viaja al orquestador en la respuesta. */
export interface Descartado {
  /** Puede faltar: si el documento no trae event_id, no hay nada que nombrar. */
  eventId: string | null;
  indice: number;
  motivo: string;
  campo: string;
  detalle: string;
}

export interface Resultado {
  procesados: Procesado[];
  descartados: Descartado[];
}

@Injectable()
export class PipelineService {
  private readonly logger = new Logger('pipeline');

  constructor(
    private readonly pseudonimo: PseudonimoService,
    private readonly mapper: MapperService,
    private readonly firmador: FirmadorService,
    private readonly cifrador: CifradorService,
    private readonly outbox: OutboxRepository,
  ) {}

  /**
   * Procesa los documentos de un lote de ENVIO (los que vinieron en un POST).
   *
   * Los documentos malos no tumban a los buenos: cada uno se resuelve solo y
   * el descarte vuelve con su motivo. Con `eventos_por_request=1` da igual,
   * pero el dia que el orquestador mande 20 por request un documento
   * defectuoso se llevaria los otros 19 por delante — y el ritmo medido caeria
   * por una causa que no es de arquitectura.
   */
  async procesar(documentos: unknown[]): Promise<Resultado> {
    const partyId = this.pseudonimo.partyId;
    const procesados: Procesado[] = [];
    const descartados: Descartado[] = [];

    for (let i = 0; i < documentos.length; i++) {
      // e0 · la llegada al mapper. Con el generador ya mudado al orquestador,
      // «payload generado» dejo de ser un momento que C3 pueda observar.
      const e0 = new Date().toISOString();
      const doc = documentos[i];

      let canonizado;
      try {
        canonizado = this.mapper.canonizar(doc, partyId);
      } catch (e) {
        if (e instanceof DocumentoInvalido) {
          descartados.push({
            eventId: eventIdDe(doc),
            indice: i,
            motivo: e.motivo,
            campo: e.campo,
            detalle: e.message,
          });
          continue;
        }
        // No es del documento: es de C3 (por ejemplo un party_id mal
        // configurado). Descartar el documento seria la reaccion equivocada
        // — el siguiente fallaria igual. Sube y tumba el lote.
        throw e;
      }
      const e1 = new Date().toISOString();

      const { firma, keyId } = await this.firmador.firmar(canonizado.canonico);
      const e2 = new Date().toISOString();

      const sobre = await this.cifrador.cifrar(canonizado.payload, firma, keyId);
      const e3 = new Date().toISOString();

      procesados.push({
        rpfId: canonizado.rpfId,
        eventId: canonizado.eventId,
        sequence: canonizado.sequence,
        payloadHash: canonizado.payloadHash,
        partyId: canonizado.partyId,
        bytesCanonicos: canonizado.bytes,
        bytesSobre: Buffer.byteLength(JSON.stringify(sobre), 'utf8'),
        sobre,
        marcas: { e0, e1, e2, e3 },
      });
    }

    // C-05 · el commit. Hasta aqui todo vivia en memoria; a partir de aqui
    // el evento existe aunque el contenedor muera. Si esto revienta, el
    // error sube y el lote NO se contesta con 202: decir «aceptado» sobre
    // eventos que no se escribieron seria una mentira que solo se descubre
    // al conciliar, cuando ya no hay forma de recuperarlos.
    const escritos = await this.outbox.escribir(procesados);
    escritos.forEach((w, i) => {
      const p = procesados[i];
      if (p) {
        p.outboxId = w.id;
        p.marcas.e4 = w.e4;
      }
    });

    if (descartados.length > 0) {
      // Un descarte por linea y con su motivo: agregado ("3 descartes") no es
      // accionable, y es exactamente el error que C4 evita en su tabla de
      // descartes.
      for (const d of descartados) {
        this.logger.warn(`descarte · ${d.motivo} · event_id=${d.eventId ?? '?'} · ${d.detalle}`);
      }
    }

    return { procesados, descartados };
  }
}

/** El event_id de un documento que no paso, si es que trae uno usable. */
function eventIdDe(doc: unknown): string | null {
  if (doc === null || typeof doc !== 'object') return null;
  const v = (doc as Record<string, unknown>)['event_id'];
  return typeof v === 'string' ? v : null;
}
