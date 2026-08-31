import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  agregarCaseHeader,
  agregarKey,
  agregarPolicy,
  agregarSharedMap,
  marcadoresTipados,
  type FilaProyectable,
} from './agregar';
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
  /**
   * Id de corrida, del MessageAttribute `prueba`. METADATO de la prueba, no
   * del evento: por eso es columna y no va dentro del payload, que va firmado
   * (regla 8). Es lo que deja que `npm run informe -- --prueba <id>` vuelque
   * exactamente una corrida en vez de una ventana de tiempo.
   */
  prueba: string | null;
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
  prueba: string | null;
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
           e8_descifrado, e9_verificado, prueba
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         ON CONFLICT (payload_hash) DO NOTHING
         RETURNING payload_hash`,
        [
          ev.payloadHash, ev.rpfId, ev.sequence, ev.eventId, ev.eventType,
          ev.schemaVersion, ev.partyId, ev.keyId, ev.occurredAt, ev.messageId,
          ev.recepciones, ev.bytesSobre, ev.bytesCanonicos, ev.sqsEnviado,
          ev.e7, ev.e7b, ev.e8, ev.e9, ev.prueba,
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

  /**
   * El lote entero en UNA transaccion y sentencias multifila.
   *
   * ── Que gana ──────────────────────────────────────────────────────────────
   *
   * `persistir()` cuesta ~8 viajes a RDS por mensaje -1 INSERT al inbox, 5
   * proyecciones, BEGIN y COMMIT- y un fsync del WAL por evento. Un lote de
   * diez son 80 viajes y 10 fsyncs. Asi son ~7 viajes y UN fsync.
   *
   * ── Las tres cosas que cambian, y hay que saberlas ────────────────────────
   *
   * 1. `e10` PASA A SER DEL LOTE. Con un solo COMMIT, los diez eventos se
   *    persisten en el mismo instante — es la verdad, no una aproximacion —
   *    pero el tramo e9→e10 deja de medir "lo que tardo ESTE evento" y pasa a
   *    medir "lo que tardo su lote". P1 cambia de significado, y por eso esto
   *    vive detras de `C4_LOTE_TRANSACCION` en vez de ser el comportamiento
   *    por defecto.
   *
   * 2. SE PIERDE EL AISLAMIENTO DEL MENSAJE ENVENENADO. Una fila mala hace
   *    rollback de las diez. El que llama tiene que reintentar el lote de a
   *    uno cuando esto lance — ver `procesarLote`.
   *
   * 3. LAS PROYECCIONES SE PRE-AGREGAN EN JS. No es una optimizacion: Postgres
   *    rechaza que una sentencia `ON CONFLICT DO UPDATE` toque la misma fila
   *    dos veces, y todos los mensajes de un lote comparten `key_id`. Ver
   *    `agregar.ts`.
   *
   * @returns por `payload_hash`, si la fila era nueva. Los que no aparecen es
   *          que ya estaban: duplicados absorbidos.
   */
  async persistirLote(evs: EventoAPersistir[]): Promise<Map<string, boolean>> {
    const salida = new Map<string, boolean>();
    if (evs.length === 0) return salida;

    // ── Dedup DENTRO del lote ──
    // Un mismo payload_hash puede venir dos veces en la misma respuesta de
    // SQS. Sin esto, el multifila del inbox lo intentaria insertar dos veces
    // -que ON CONFLICT DO NOTHING tolera- pero las proyecciones lo contarian
    // dos veces, y esos si son contadores que no cuadran.
    const primeros = new Map<string, EventoAPersistir>();
    const veces = new Map<string, number>();
    for (const ev of evs) {
      veces.set(ev.payloadHash, (veces.get(ev.payloadHash) ?? 0) + 1);
      if (!primeros.has(ev.payloadHash)) primeros.set(ev.payloadHash, ev);
    }
    const unicos = [...primeros.values()];

    await this.bd.enTransaccion(async (c) => {
      // ── 1. El inbox ──
      const cols =
        'payload_hash, rpf_id, sequence, event_id, event_type, schema_version, ' +
        'party_id, key_id, occurred_at, message_id, recepciones, bytes_sobre, ' +
        'bytes_canonicos, sqs_enviado, e7_recibido, e7b_tomado, e8_descifrado, ' +
        'e9_verificado, prueba';
      const tipos = [
        'text', 'uuid', 'int', 'uuid', 'text', 'text', 'text', 'text', 'timestamptz',
        'text', 'int', 'int', 'int', 'timestamptz', 'timestamptz', 'timestamptz',
        'timestamptz', 'timestamptz', 'text',
      ];
      const vals = unicos.flatMap((ev) => [
        ev.payloadHash, ev.rpfId, ev.sequence, ev.eventId, ev.eventType,
        ev.schemaVersion, ev.partyId, ev.keyId, ev.occurredAt, ev.messageId,
        ev.recepciones, ev.bytesSobre, ev.bytesCanonicos, ev.sqsEnviado,
        ev.e7, ev.e7b, ev.e8, ev.e9, ev.prueba,
      ]);

      const r = await c.query<{ payload_hash: string }>(
        `INSERT INTO ${this.e}.inbox (${cols})
         VALUES ${marcadoresTipados(unicos.length, tipos)}
         ON CONFLICT (payload_hash) DO NOTHING
         RETURNING payload_hash`,
        vals,
      );
      const nuevos = new Set(r.rows.map((x) => x.payload_hash));
      for (const h of veces.keys()) salida.set(h, nuevos.has(h));

      // ── 2. Los duplicados, con su cuenta ──
      // Un UPDATE ... FROM (VALUES ...) y no un `= ANY($1)`: si el mismo hash
      // llego tres veces hay que sumar tres, no uno.
      const dup: Array<[string, number]> = [];
      for (const [hash, n] of veces) {
        const extras = nuevos.has(hash) ? n - 1 : n;
        if (extras > 0) dup.push([hash, extras]);
      }
      if (dup.length > 0) {
        await c.query(
          `UPDATE ${this.e}.inbox AS i
              SET duplicados  = i.duplicados  + v.n,
                  recepciones = i.recepciones + v.n
             FROM (VALUES ${marcadoresTipados(dup.length, ['text', 'int'])}) AS v(payload_hash, n)
            WHERE i.payload_hash = v.payload_hash`,
          dup.flat(),
        );
      }

      // ── 3. Las proyecciones, solo de lo nuevo ──
      const aProyectar = unicos.filter((ev) => nuevos.has(ev.payloadHash));
      if (aProyectar.length > 0) await this.proyectarLote(c, aProyectar);
    });

    return salida;
  }

  /** G-04 · los cinco schemas, en cinco sentencias para todo el lote. */
  private async proyectarLote(c: PoolClient, evs: EventoAPersistir[]): Promise<void> {
    // 1. Journal — append-only, sin conflicto posible: multifila directo.
    await c.query(
      `INSERT INTO ${this.e}.journal
         (payload_hash, rpf_id, sequence, event_id, event_type, occurred_at, payload)
       VALUES ${marcadoresTipados(evs.length, ['text', 'uuid', 'int', 'uuid', 'text', 'timestamptz', 'jsonb'])}`,
      evs.flatMap((ev) => [
        ev.payloadHash, ev.rpfId, ev.sequence, ev.eventId, ev.eventType, ev.occurredAt,
        this.config.guardarPayload ? JSON.stringify(ev.payload) : null,
      ]),
    );

    const filas = evs.map((ev) => proyectable(ev));

    // 2. Case Header — `+ EXCLUDED.eventos` y no `+ 1`: la fila que llega ya
    //    trae la cuenta del lote para ese expediente.
    const cabeceras = agregarCaseHeader(filas);
    if (cabeceras.length > 0) {
      await c.query(
        `INSERT INTO ${this.e}.case_header
           (rpf_id, party_id, primer_evento, ultimo_evento, eventos,
            sequence_min, sequence_max, ultimo_tipo, access_key, total_products)
         VALUES ${marcadoresTipados(cabeceras.length, ['uuid', 'text', 'timestamptz', 'timestamptz', 'int', 'int', 'int', 'text', 'text', 'text'])}
         ON CONFLICT (rpf_id) DO UPDATE SET
           primer_evento  = LEAST(${this.e}.case_header.primer_evento, EXCLUDED.primer_evento),
           ultimo_evento  = GREATEST(${this.e}.case_header.ultimo_evento, EXCLUDED.ultimo_evento),
           eventos        = ${this.e}.case_header.eventos + EXCLUDED.eventos,
           sequence_min   = LEAST(${this.e}.case_header.sequence_min, EXCLUDED.sequence_min),
           sequence_max   = GREATEST(${this.e}.case_header.sequence_max, EXCLUDED.sequence_max),
           ultimo_tipo    = CASE WHEN EXCLUDED.sequence_max >= ${this.e}.case_header.sequence_max
                                 THEN EXCLUDED.ultimo_tipo ELSE ${this.e}.case_header.ultimo_tipo END,
           access_key     = COALESCE(EXCLUDED.access_key, ${this.e}.case_header.access_key),
           total_products = COALESCE(EXCLUDED.total_products, ${this.e}.case_header.total_products),
           actualizado    = now()`,
        cabeceras.flatMap((h) => [
          h.rpfId, h.partyId, h.primerEvento, h.ultimoEvento, h.eventos,
          h.sequenceMin, h.sequenceMax, h.ultimoTipo, h.accessKey, h.totalProducts,
        ]),
      );
    }

    // 3. Shared Map
    const pares = agregarSharedMap(filas);
    if (pares.length > 0) {
      await c.query(
        `INSERT INTO ${this.e}.shared_map
           (party_id, counterparty_cnpj, uf, expedientes, eventos)
         VALUES ${marcadoresTipados(pares.length, ['text', 'text', 'text', 'int', 'int'])}
         ON CONFLICT (party_id, counterparty_cnpj) DO UPDATE SET
           eventos      = ${this.e}.shared_map.eventos + EXCLUDED.eventos,
           expedientes  = ${this.e}.shared_map.expedientes + EXCLUDED.expedientes,
           uf           = COALESCE(EXCLUDED.uf, ${this.e}.shared_map.uf),
           visto_ultimo = now()`,
        pares.flatMap((p) => [p.partyId, p.cnpj, p.uf, p.expedientes, p.eventos]),
      );
    }

    // 4. Policy Registry
    const politicas = agregarPolicy(filas);
    if (politicas.length > 0) {
      await c.query(
        `INSERT INTO ${this.e}.policy_registry (event_type, schema_version, eventos)
         VALUES ${marcadoresTipados(politicas.length, ['text', 'text', 'int'])}
         ON CONFLICT (event_type, schema_version) DO UPDATE SET
           eventos = ${this.e}.policy_registry.eventos + EXCLUDED.eventos,
           visto_ultimo = now()`,
        politicas.flatMap((p) => [p.eventType, p.schemaVersion, p.eventos]),
      );
    }

    // 5. Key Registry — la que hace obligatoria la pre-agregacion.
    const llaves = agregarKey(filas);
    await c.query(
      `INSERT INTO ${this.e}.key_registry (key_id, sig_alg, aceptada, eventos)
       VALUES ${marcadoresTipados(llaves.length, ['text', 'text', 'boolean', 'int'])}
       ON CONFLICT (key_id) DO UPDATE SET
         eventos = ${this.e}.key_registry.eventos + EXCLUDED.eventos,
         visto_ultimo = now()`,
      llaves.flatMap((l) => [l.keyId, l.sigAlg, true, l.eventos]),
    );
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
            bytes_sobre, recepciones, a_la_dlq, e7_recibido, prueba)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          d.payloadHash, d.rpfId, d.messageId, d.motivo, d.alarma, d.detalle,
          d.bytesSobre, d.recepciones, d.aLaDlq, d.e7, d.prueba,
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
   * Y el fallo mas probable de esta PoC -un relay que se detiene con filas
   * todavia pendientes en su outbox- se lleva justo la cola. Desde C4 ese caso es
   * indistinguible de un expediente que termino ahi.
   *
   * Por eso este metodo no decide nada: vuelca lo que hay para que el
   * manifiesto del orquestador -que si sabe lo que se emitio- lo reste.
   *
   * ────────────────────────────────────────────────────────────────────
   *
   * ⚠ HAY QUE RECORTAR, Y HAY DOS FORMAS. La base de C4 sobrevive a la
   * corrida: sin corte, el volcado arrastra los expedientes de todas las
   * pruebas anteriores y la conciliacion los reporta como desconocidos por
   * centenares.
   *
   *   prueba  EXACTO. Es el id de corrida que llego en el MessageAttribute,
   *           el mismo que genero el orquestador. Distingue dos corridas que
   *           se solapan y no depende de acertar una hora.
   *   desde   APROXIMADO, por `e7_recibido`. Es el corte que habia antes de
   *           que el id viajara hasta aqui, y el unico que sirve para los
   *           mensajes que llegaron SIN atributo.
   *
   * Se pueden combinar; los dos son opcionales.
   */
  async expedientes(desde?: string | null, prueba?: string | null): Promise<Array<{
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
        WHERE ($1::timestamptz IS NULL OR e7_recibido >= $1::timestamptz)
          AND ($2::text IS NULL OR prueba = $2::text)
        GROUP BY rpf_id
        ORDER BY rpf_id`,
      [desde ?? null, prueba ?? null],
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

  /**
   * El conteo que responde P4.
   *
   * Con `prueba`, todo lo que se puede acotar por corrida se acota; lo que no
   * lleva la columna —`journal` y `case_header`, que son el libro y no el
   * registro de llegada— se sigue contando entero y se marca en el nombre
   * (`_total`). Devolver un `journal` recortado exigiria unirlo al inbox en
   * cada consulta para acabar contando lo mismo que `inbox`, y presentarlo
   * como si fuera "el libro de esta corrida" invitaria a leerlo como lo que
   * no es: el libro es acumulativo a proposito.
   */
  async conciliacion(prueba?: string | null): Promise<Record<string, number>> {
    const { rows } = await this.bd.pool.query<Record<string, string>>(
      `SELECT
         (SELECT COUNT(*) FROM ${this.e}.inbox
           WHERE $1::text IS NULL OR prueba = $1::text)                      AS inbox,
         (SELECT COALESCE(SUM(duplicados),0) FROM ${this.e}.inbox
           WHERE $1::text IS NULL OR prueba = $1::text)                      AS duplicados,
         (SELECT COUNT(*) FROM ${this.e}.inbox
           WHERE e10_persistido IS NULL
             AND ($1::text IS NULL OR prueba = $1::text))                    AS sin_e10,
         (SELECT COUNT(*) FROM ${this.e}.descartes
           WHERE $1::text IS NULL OR prueba = $1::text)                      AS descartes,
         (SELECT COUNT(*) FROM ${this.e}.descartes
           WHERE alarma AND ($1::text IS NULL OR prueba = $1::text))         AS descartes_con_alarma,
         (SELECT COUNT(*) FROM ${this.e}.journal)                            AS journal_total,
         (SELECT COUNT(*) FROM ${this.e}.case_header)                        AS expedientes_total`,
      [prueba ?? null],
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

/**
 * De un evento del inbox a lo que necesitan las proyecciones.
 *
 * Existe para que `agregar.ts` no dependa del tipo entero de un evento -y por
 * tanto sea probable sin base de datos ni payloads de verdad-.
 */
function proyectable(ev: EventoAPersistir): FilaProyectable {
  const p = ev.payload;
  const doc = obj(p.document);
  const totals = obj(p.totals);
  const contra = obj(p.counterparty);
  return {
    rpfId: ev.rpfId,
    sequence: ev.sequence,
    partyId: ev.partyId,
    keyId: ev.keyId,
    sigAlg: ev.sigAlg,
    eventType: ev.eventType,
    schemaVersion: ev.schemaVersion,
    occurredAt: ev.occurredAt,
    accessKey: str(doc.access_key),
    totalProducts: str(totals.products),
    contraparteCnpj: str(contra.cnpj),
    contraparteUf: str(contra.uf),
  };
}
