import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { aRangos, type Rango } from '../comun/rangos';
import { ConfigService } from '../config/config.service';
import { BdService } from './bd.service';

export interface EventoAPersistir {
  payloadHash: string;
  rpfId: string;
  sequence: number;
  eventId: string | null;
  eventType: string | null;
  schemaVersion: string | null;
  partyId: string | null;
  keyId: string;
  sigAlg: string;
  occurredAt: string | null;
  messageId: string | null;
  recepciones: number;
  bytesSobre: number;
  bytesCanonicos: number;
  sqsEnviado: Date | null;
  e7: Date;
  e7b: Date;
  e8: Date;
  e9: Date;
  payload: Record<string, unknown>;
}

export interface Descarte {
  payloadHash: string | null;
  rpfId: string | null;
  messageId: string | null;
  motivo: string;
  alarma: boolean;
  detalle: string;
  bytesSobre: number;
  recepciones: number;
  aLaDlq: boolean;
  e7: Date;
}

export interface ResultadoPersistencia {
  nuevo: boolean;
  /** Se estampa DESPUES del COMMIT. */
  e10: Date;
}

@Injectable()
export class InboxRepository {
  private readonly logger = new Logger('inbox');
  private readonly e: string;

  constructor(
    private readonly bd: BdService,
    private readonly config: ConfigService,
  ) {
    this.e = `"${config.bdEsquema.replace(/"/g, '')}"`;
  }

  /**
   * G-03 + G-04 · el asiento completo, en UNA transaccion.
   *
   * Inbox y proyeccion tienen que ir juntos por la misma razon por la que el
   * outbox de C3 va en la transaccion de negocio (regla 2): si se separan, un
   * fallo entre los dos deja un payload_hash marcado como visto y un journal sin
   * el asiento. El reintento lo veria como duplicado y no lo escribiria nunca.
   * El evento quedaria contado en P4 y ausente del libro.
   */
  async persistir(ev: EventoAPersistir): Promise<ResultadoPersistencia> {
    const nuevo = await this.bd.enTransaccion(async (c) => {
      // ON CONFLICT DO NOTHING ... RETURNING: vacio = ya estaba. Es la
      // idempotencia entera, y descansa en que payload_hash se calcula sobre el
      // canonico EN CLARO, no sobre el ciphertext (regla 5).
      const r = await c.query<{ payload_hash: string }>(
        `INSERT INTO ${this.e}.inbox (
           payload_hash, rpf_id, sequence, event_id, event_type, schema_version,
           party_id, key_id, occurred_at, message_id, recepciones,
           bytes_sobre, bytes_canonicos, sqs_enviado, e7_recibido, e7b_tomado,
           e8_descifrado, e9_verificado
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         ON CONFLICT (payload_hash) DO NOTHING
         RETURNING payload_hash`,
        [
          ev.payloadHash, ev.rpfId, ev.sequence, ev.eventId, ev.eventType,
          ev.schemaVersion, ev.partyId, ev.keyId, ev.occurredAt, ev.messageId,
          ev.recepciones, ev.bytesSobre, ev.bytesCanonicos, ev.sqsEnviado,
          ev.e7, ev.e7b, ev.e8, ev.e9,
        ],
      );

      if (r.rowCount === 0) {
        // Duplicado: se cuenta y NO se proyecta. Contarlo importa — es la
        // prueba de que la entrega al-menos-una-vez esta ocurriendo de
        // verdad y de que el inbox la esta absorbiendo (regla 4).
        await c.query(
          `UPDATE ${this.e}.inbox
              SET duplicados = duplicados + 1, recepciones = recepciones + 1
            WHERE payload_hash = $1`,
          [ev.payloadHash],
        );
        return false;
      }

      await this.proyectar(c, ev);
      return true;
    });

    // e10 DESPUES del COMMIT, no cuando el INSERT retorna (G-06). Si se
    // estampara antes, el tramo e9→e10 se perderia justo la parte que se
    // vuelve lenta bajo carga: el fsync del commit.
    return { nuevo, e10: new Date() };
  }

  /** G-04 · los cinco schemas. */
  private async proyectar(c: PoolClient, ev: EventoAPersistir): Promise<void> {
    const p = ev.payload;
    const doc = obj(p.document);
    const totals = obj(p.totals);
    const contra = obj(p.counterparty);

    // 1. Journal — append-only. Un INSERT, nunca un UPDATE.
    await c.query(
      `INSERT INTO ${this.e}.journal
         (payload_hash, rpf_id, sequence, event_id, event_type, occurred_at, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        ev.payloadHash, ev.rpfId, ev.sequence, ev.eventId, ev.eventType, ev.occurredAt,
        this.config.guardarPayload ? JSON.stringify(p) : null,
      ],
    );

    // 2. Case Header — el estado consultable del expediente.
    //    GREATEST/LEAST y no "el ultimo que llego": FIFO garantiza orden por
    //    grupo, pero un reproceso tras un visibility timeout puede reordenar
    //    dos eventos ya vistos. Con GREATEST, reprocesar es inofensivo.
    await c.query(
      `INSERT INTO ${this.e}.case_header
         (rpf_id, party_id, primer_evento, ultimo_evento, eventos,
          sequence_min, sequence_max, ultimo_tipo, access_key, total_products)
       VALUES ($1,$2,$3,$3,1,$4,$4,$5,$6,$7)
       ON CONFLICT (rpf_id) DO UPDATE SET
         primer_evento  = LEAST(${this.e}.case_header.primer_evento, EXCLUDED.primer_evento),
         ultimo_evento  = GREATEST(${this.e}.case_header.ultimo_evento, EXCLUDED.ultimo_evento),
         eventos        = ${this.e}.case_header.eventos + 1,
         sequence_min   = LEAST(${this.e}.case_header.sequence_min, EXCLUDED.sequence_min),
         sequence_max   = GREATEST(${this.e}.case_header.sequence_max, EXCLUDED.sequence_max),
         ultimo_tipo    = CASE WHEN EXCLUDED.sequence_max >= ${this.e}.case_header.sequence_max
                               THEN EXCLUDED.ultimo_tipo ELSE ${this.e}.case_header.ultimo_tipo END,
         access_key     = COALESCE(EXCLUDED.access_key, ${this.e}.case_header.access_key),
         total_products = COALESCE(EXCLUDED.total_products, ${this.e}.case_header.total_products),
         actualizado    = now()`,
      [
        ev.rpfId, ev.partyId, ev.occurredAt, ev.sequence, ev.eventType,
        str(doc.access_key), str(totals.products),
      ],
    );

    // 3. Shared Map — con quien opera el participante. `expedientes` se
    //    incrementa solo en el primer evento del rpf_id, que es sequence 1:
    //    contarlo en cada evento convertiria la columna en un duplicado de
    //    `eventos` y dejaria de significar nada.
    const cnpj = str(contra.cnpj);
    if (ev.partyId && cnpj) {
      await c.query(
        `INSERT INTO ${this.e}.shared_map
           (party_id, counterparty_cnpj, uf, expedientes, eventos)
         VALUES ($1,$2,$3,$4,1)
         ON CONFLICT (party_id, counterparty_cnpj) DO UPDATE SET
           eventos      = ${this.e}.shared_map.eventos + 1,
           expedientes  = ${this.e}.shared_map.expedientes + EXCLUDED.expedientes,
           uf           = COALESCE(EXCLUDED.uf, ${this.e}.shared_map.uf),
           visto_ultimo = now()`,
        [ev.partyId, cnpj, str(contra.uf), ev.sequence <= 1 ? 1 : 0],
      );
    }

    // 4. Policy Registry — que tipos y que versiones estan en curso.
    if (ev.eventType && ev.schemaVersion) {
      await c.query(
        `INSERT INTO ${this.e}.policy_registry (event_type, schema_version, eventos)
         VALUES ($1,$2,1)
         ON CONFLICT (event_type, schema_version) DO UPDATE SET
           eventos = ${this.e}.policy_registry.eventos + 1, visto_ultimo = now()`,
        [ev.eventType, ev.schemaVersion],
      );
    }

    // 5. Key Registry — que llave cubrio que eventos.
    await c.query(
      `INSERT INTO ${this.e}.key_registry (key_id, sig_alg, aceptada, eventos)
       VALUES ($1,$2,true,1)
       ON CONFLICT (key_id) DO UPDATE SET
         eventos = ${this.e}.key_registry.eventos + 1, visto_ultimo = now()`,
      [ev.keyId, ev.sigAlg],
    );
  }

  /**
   * e10 de todo el lote en una sentencia.
   *
   * Una UPDATE por evento agregaria un viaje de red a cada uno DESPUES de que
   * el reloj ya paro, asi que no falsea la medicion — pero si baja el
   * rendimiento justo en el componente que la PoC quiere ver saturarse.
   */
  async estamparE10(marcas: Array<{ payloadHash: string; e10: Date }>): Promise<void> {
    if (marcas.length === 0) return;
    await this.bd.pool.query(
      `UPDATE ${this.e}.inbox AS i
          SET e10_persistido = v.e10
         FROM (SELECT unnest($1::text[]) AS payload_hash, unnest($2::timestamptz[]) AS e10) AS v
        WHERE i.payload_hash = v.payload_hash`,
      [marcas.map((m) => m.payloadHash), marcas.map((m) => m.e10.toISOString())],
    );
  }

  /** G-07 · la evidencia de lo descartado, para que P4 cierre. */
  async anotarDescarte(d: Descarte): Promise<void> {
    try {
      await this.bd.pool.query(
        `INSERT INTO ${this.e}.descartes
           (payload_hash, rpf_id, message_id, motivo, alarma, detalle,
            bytes_sobre, recepciones, a_la_dlq, e7_recibido)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          d.payloadHash, d.rpfId, d.messageId, d.motivo, d.alarma, d.detalle,
          d.bytesSobre, d.recepciones, d.aLaDlq, d.e7,
        ],
      );
    } catch (e) {
      // No propaga: si la base no acepta el descarte, el mensaje ya esta en
      // la DLQ y la evidencia sigue existiendo alli. Propagar lo devolveria a
      // la cola principal para reprocesarse eternamente.
      this.logger.error(`no se pudo anotar el descarte (${d.motivo}): ${String(e)}`);
    }
  }

  /**
   * G-05 · huecos de sequence por rpf_id.
   *
   * Con FIFO no deberia salir ninguno, y por eso vale medirlo: un solo hueco
   * invalida la afirmacion de orden, y eso es un hallazgo mas grave que
   * cualquier latencia.
   */
  async huecos(): Promise<Array<{ rpf_id: string; esperados: number; vistos: number; faltan: number[] }>> {
    const { rows } = await this.bd.pool.query<{
      rpf_id: string; smin: number; smax: number; vistos: number; presentes: number[];
    }>(
      `SELECT rpf_id,
              MIN(sequence) AS smin, MAX(sequence) AS smax,
              COUNT(*)::int AS vistos,
              array_agg(DISTINCT sequence ORDER BY sequence) AS presentes
         FROM ${this.e}.inbox
        GROUP BY rpf_id
       HAVING MAX(sequence) - MIN(sequence) + 1 <> COUNT(DISTINCT sequence)`,
    );

    return rows.map((r) => {
      const hay = new Set(r.presentes);
      const faltan: number[] = [];
      for (let s = r.smin; s <= r.smax; s++) if (!hay.has(s)) faltan.push(s);
      return { rpf_id: r.rpf_id, esperados: r.smax - r.smin + 1, vistos: r.vistos, faltan };
    });
  }

  /**
   * G-08 · Lo que llego, por expediente, comprimido en rangos.
   *
   * ────────────────────────────────────────────────────────────────────
   * ESTO NO ES DETECCION DE HUECOS. ES LA MITAD DE ELLA.
   *
   * `huecos()` (arriba) solo encuentra huecos INTERIORES, porque el rango con
   * el que compara sale de los propios datos que llegaron:
   *
   *   falta el 5 de 1..10  →  lo ve
   *   falta el 1           →  no: MIN pasa a 2 y 2..10 es denso
   *   faltan el 9 y el 10  →  no: MAX pasa a 8 y 1..8 es denso
   *   falta el expediente  →  no: no hay ni fila que agrupar
   *
   * Y el fallo mas probable de esta PoC -una tarea de Fargate que muere con su
   * outbox efimero dentro- se lleva justo la cola. Desde C4 ese caso es
   * indistinguible de un expediente que termino ahi.
   *
   * Por eso este metodo no decide nada: vuelca lo que hay para que el
   * manifiesto del orquestador -que si sabe lo que se emitio- lo reste.
   *
   * `desde` corta por `e7_recibido`. Sin el, el volcado arrastra los
   * expedientes de corridas anteriores que siguen en la base y la conciliacion
   * los reporta como desconocidos por centenares.
   * ────────────────────────────────────────────────────────────────────
   */
  async expedientes(desde?: string | null): Promise<Array<{
    rpf_id: string; vistos: number; duplicados: number; sequences: Rango[];
  }>> {
    const { rows } = await this.bd.pool.query<{
      rpf_id: string; vistos: string; duplicados: string; presentes: number[];
    }>(
      `SELECT rpf_id,
              COUNT(*)                                        AS vistos,
              COALESCE(SUM(duplicados), 0)                    AS duplicados,
              array_agg(DISTINCT sequence ORDER BY sequence)  AS presentes
         FROM ${this.e}.inbox
        WHERE $1::timestamptz IS NULL OR e7_recibido >= $1::timestamptz
        GROUP BY rpf_id
        ORDER BY rpf_id`,
      [desde ?? null],
    );

    return rows.map((r) => ({
      rpf_id: r.rpf_id,
      // `vistos` cuenta FILAS, que son eventos unicos: el duplicado no inserta
      // otra fila, incrementa un contador. Sumarlos daria mas llegados que
      // emitidos y el residuo de P4 saldria negativo.
      vistos: Number(r.vistos),
      duplicados: Number(r.duplicados),
      sequences: aRangos(r.presentes),
    }));
  }

  /** El conteo que responde P4. */
  async conciliacion(): Promise<Record<string, number>> {
    const { rows } = await this.bd.pool.query<Record<string, string>>(
      `SELECT
         (SELECT COUNT(*) FROM ${this.e}.inbox)                             AS inbox,
         (SELECT COALESCE(SUM(duplicados),0) FROM ${this.e}.inbox)          AS duplicados,
         (SELECT COUNT(*) FROM ${this.e}.inbox WHERE e10_persistido IS NULL) AS sin_e10,
         (SELECT COUNT(*) FROM ${this.e}.journal)                            AS journal,
         (SELECT COUNT(*) FROM ${this.e}.case_header)                        AS expedientes,
         (SELECT COUNT(*) FROM ${this.e}.descartes)                          AS descartes,
         (SELECT COUNT(*) FROM ${this.e}.descartes WHERE alarma)             AS descartes_con_alarma`,
    );
    const r = rows[0] ?? {};
    return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v)]));
  }
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}
