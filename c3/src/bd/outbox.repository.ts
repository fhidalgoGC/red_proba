/**
 * C-05 · La escritura del outbox, dentro de la transaccion de negocio.
 *
 * ⚠ ESTA TABLA ES LA UNICA FUENTE DE LO QUE LLEGA A C4. El relay (C-06) no lee
 * de ningun otro sitio: lo que no quede aqui no se publica y, por lo tanto, no
 * existe para C4. Todo lo que hay en este archivo esta puesto para que ninguna
 * fila se pierda entre «C3 contesto 202» y «la fila esta en el outbox».
 *
 * LAS DOS REGLAS QUE SOSTIENE:
 *
 * Regla 2 — el outbox se escribe en la MISMA transaccion que el estado de
 * negocio. Si fueran dos escrituras separadas no tendrias un outbox: tendrias
 * dos tablas que se desincronizan la primera vez que el proceso muera entre
 * una y otra. Con una sola transaccion hay dos desenlaces y los dos son sanos:
 * o estan las dos escrituras, o no esta ninguna.
 *
 * Regla 3 — el COMMIT ocurre ANTES de publicar, nunca al reves. Aqui no se
 * publica nada; ni siquiera se importa el cliente de SQS. Publicar dentro de
 * la transaccion daria el caso «se publico y luego el commit fallo»: un evento
 * en la cola que no existe en tu base, imposible de reconciliar y de detectar.
 */
import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { BdService } from './bd.service';
import type { Procesado } from '../pipeline/pipeline.service';

/** Una fila que el relay tomo y tiene que publicar. */
export interface Reclamado {
  id: string;
  rpfId: string;
  payloadHash: string;
  envelope: Record<string, unknown>;
  /** Ya incrementado por el propio reclamo. */
  attempts: number;
  e5: string;
}

export interface Escrito {
  /** El `id` del outbox, para poder seguir la fila en los logs. */
  id: string;
  payloadHash: string;
  /** Cuando la transaccion escribio la fila. Es `e4`. */
  e4: string;
}

@Injectable()
export class OutboxRepository {
  private readonly logger = new Logger('outbox');
  private readonly e: string;

  readonly contadores = {
    transacciones: 0,
    filas: 0,
    fallos: 0,
    reclamadas: 0,
    enviadas: 0,
    fallidas: 0,
  };

  constructor(private readonly bd: BdService) {
    this.e = `"${bd.esquema.replace(/"/g, '')}"`;
  }

  /**
   * Escribe un lote entero: el estado de negocio de cada expediente y su fila
   * de outbox, todo en UNA transaccion.
   *
   * ⚠ UNA TRANSACCION POR LOTE, no por evento. Con `eventos_por_request=1` da
   * igual, pero con 20 documentos serian 20 BEGIN/COMMIT y 20 fsync donde
   * basta uno. El invariante de la regla 2 se mantiene igual —cada fila de
   * outbox sigue compartiendo transaccion con su expediente— y el precio es
   * que un fallo tumba el lote entero en vez de un documento.
   *
   * Ese precio es el correcto aqui: un fallo a esta altura es de la BASE
   * (caida, disco lleno, deadlock), no del documento. Reintentar 19 de 20 no
   * arreglaria nada y dejaria el lote a medias, que es peor de reconciliar
   * que un lote entero ausente.
   */
  async escribir(procesados: Procesado[]): Promise<Escrito[]> {
    if (procesados.length === 0) return [];

    try {
      const escritos = await this.bd.enTransaccion(async (c) => {
        // 1 · el estado de negocio. Va PRIMERO por una razon de bloqueos:
        // varios lotes concurrentes del mismo expediente compiten por esta
        // fila, y tomar el candado antes de insertar en outbox acorta la
        // ventana en la que el candado se tiene.
        await this.actualizarExpedientes(c, procesados);

        // 2 · el outbox, en la misma transaccion. Un solo INSERT con todas
        // las filas: N inserts serian N round trips a la base dentro del
        // candado.
        return this.insertarOutbox(c, procesados);
      });

      this.contadores.transacciones += 1;
      this.contadores.filas += escritos.length;
      return escritos;
    } catch (e) {
      this.contadores.fallos += 1;
      // Se registra aqui y se relanza: quien llama tiene que enterarse de que
      // NO se escribio nada. Un 202 tras un rollback seria una mentira —
      // C3 estaria diciendo «aceptado» sobre eventos que jamas se publicaran.
      this.logger.error(`la transaccion del lote fallo (${procesados.length} eventos): ${msj(e)}`);
      throw e;
    }
  }

  /**
   * El "thread" por rpf_id. Un UPSERT por expediente distinto del lote.
   *
   * `GREATEST`/`LEAST` y no una asignacion directa: los eventos de un mismo
   * expediente pueden llegar desordenados —el orquestador dispara sin esperar
   * respuesta (O-02)— y una asignacion haria que el `sequence_max` retrocediera
   * cuando llega uno viejo.
   */
  private async actualizarExpedientes(c: PoolClient, procesados: Procesado[]): Promise<void> {
    const porRpf = new Map<string, Procesado[]>();
    for (const p of procesados) {
      const l = porRpf.get(p.rpfId);
      if (l) l.push(p);
      else porRpf.set(p.rpfId, [p]);
    }

    // Orden estable por rpf_id: dos lotes que tocan los mismos expedientes en
    // orden distinto se bloquean en cruz y Postgres mata uno por deadlock.
    // Ordenar hace que todos tomen los candados en la misma secuencia.
    for (const rpfId of [...porRpf.keys()].sort()) {
      const grupo = porRpf.get(rpfId)!;
      const seqs = grupo.map((g) => g.sequence);
      await c.query(
        `INSERT INTO ${this.e}.expediente
           (rpf_id, eventos, sequence_min, sequence_max, primer_evento, ultimo_evento, actualizado)
         VALUES ($1, $2, $3, $4, now(), now(), now())
         ON CONFLICT (rpf_id) DO UPDATE SET
           eventos      = ${this.e}.expediente.eventos + EXCLUDED.eventos,
           sequence_min = LEAST(${this.e}.expediente.sequence_min, EXCLUDED.sequence_min),
           sequence_max = GREATEST(${this.e}.expediente.sequence_max, EXCLUDED.sequence_max),
           ultimo_evento = now(),
           actualizado   = now()`,
        [rpfId, grupo.length, Math.min(...seqs), Math.max(...seqs)],
      );
    }
  }

  /**
   * Las filas del outbox. `status='PENDING'` y `next_attempt=now()`: el relay
   * las ve en su siguiente tick.
   *
   * ⚠ `e4_commit` LO PONE EL PROCESO, no la base.
   *
   * Antes usaba `clock_timestamp()` de Postgres, que daba precision por fila
   * dentro del lote. Estaba mal, y costo un test intermitente en encontrarlo:
   * `e5` salia del reloj de Postgres y `e6` del reloj de Node, asi que el
   * tramo e5→e6 podia dar NEGATIVO cuando la publicacion tardaba menos que la
   * deriva entre los dos relojes. En local son el contenedor de Docker y el
   * host; en AWS serian el RDS y la tarea de Fargate — dos maquinas.
   *
   * M-06 acepta esa deriva entre C3 y C4, que estan en cuentas distintas y no
   * hay alternativa. Pero DENTRO de C3 no hay excusa: e0..e6 salen todas del
   * reloj de este proceso y los seis intervalos son coherentes por
   * construccion.
   *
   * Lo que se pierde es la precision por fila dentro de un lote — todas
   * comparten marca. No importa: se escriben en un solo INSERT, asi que su
   * instante real ES el mismo.
   */
  private async insertarOutbox(c: PoolClient, procesados: Procesado[]): Promise<Escrito[]> {
    const e4 = new Date().toISOString();
    const COLS = 7;
    const tuplas = procesados.map((_, i) => {
      const b = i * COLS;
      return `($${b + 1}, $${b + 2}, $${b + 3}::jsonb, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${procesados.length * COLS + 1}::timestamptz)`;
    });
    const valores = procesados.flatMap((p) => [
      p.rpfId,
      p.payloadHash,
      JSON.stringify(p.sobre),
      p.marcas.e0,
      p.marcas.e1,
      p.marcas.e2,
      p.marcas.e3,
    ]);
    valores.push(e4);

    const { rows } = await c.query<{ id: string; payload_hash: string; e4_commit: Date }>(
      `INSERT INTO ${this.e}.outbox
         (rpf_id, payload_hash, envelope, e0_listo, e1_canonizado, e2_firmado, e3_cifrado, e4_commit)
       VALUES ${tuplas.join(', ')}
       RETURNING id, payload_hash, e4_commit`,
      valores,
    );

    return rows.map((r) => ({
      id: String(r.id),
      payloadHash: r.payload_hash,
      e4: r.e4_commit.toISOString(),
    }));
  }


  // ═══════════════════════════════════════════════════════════════════════
  // C-06 · lo que el relay le pide al outbox
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Reclama hasta `limite` filas pendientes y las marca como intentadas.
   *
   * ⚠ EL `attempts + 1` OCURRE AL RECLAMAR, NO AL FALLAR. Si se incrementara
   * al fallar, el ROLLBACK de esa transaccion desharia el contador y el
   * reintento seria inmediato en vez de escalonado: una fila problematica
   * giraria en bucle a toda velocidad y el relay no avanzaria nunca.
   *
   * ⚠ ESTE UPDATE HACE COMMIT ANTES DE PUBLICAR. A partir de ahi hay tres
   * desenlaces y los tres son sanos:
   *   · publica bien           → una segunda transaccion la marca SENT
   *   · falla la publicacion   → nada que deshacer: ya tiene attempts+1 y
   *                              next_attempt futuro, se reintenta sola
   *   · el contenedor muere    → identico al anterior
   * Por eso no hace falta transaccion autonoma ni logica de compensacion.
   *
   * `FOR UPDATE SKIP LOCKED` evita que dos workers tomen las mismas filas.
   * El `random()` del jitter evita el thundering herd: cuando SQS devuelve
   * throttling, los 50 contenedores fallan casi a la vez y sin jitter
   * reintentarian todos en el mismo instante.
   */
  async reclamar(limite: number, capSeg: number): Promise<Reclamado[]> {
    // Del reloj de ESTE proceso, como e0..e4 y e6. Ver la nota de e4_commit:
    // mezclar el reloj de Postgres con el de Node hacia que e5→e6 pudiera
    // salir negativo.
    const e5 = new Date().toISOString();
    const { rows } = await this.bd.pool.query<{
      id: string;
      rpf_id: string;
      payload_hash: string;
      envelope: unknown;
      attempts: number;
      e5_reclamado: Date;
    }>(
      `WITH lote AS (
         SELECT id FROM ${this.e}.outbox
          WHERE status = 'PENDING'
            AND next_attempt <= now()
          ORDER BY created_at
          LIMIT $1
            FOR UPDATE SKIP LOCKED
       )
       UPDATE ${this.e}.outbox o
          SET attempts      = o.attempts + 1,
              next_attempt  = now() + (interval '1 second'
                            * least(power(2, o.attempts), $2::numeric)
                            * (0.5 + random())),
              e5_reclamado  = $3::timestamptz
         FROM lote
        WHERE o.id = lote.id
        RETURNING o.id, o.rpf_id, o.payload_hash, o.envelope, o.attempts, o.e5_reclamado`,
      [limite, capSeg, e5],
    );

    this.contadores.reclamadas += rows.length;
    return rows.map((r) => ({
      id: String(r.id),
      rpfId: r.rpf_id,
      payloadHash: r.payload_hash,
      envelope: r.envelope as Record<string, unknown>,
      attempts: r.attempts,
      e5: r.e5_reclamado.toISOString(),
    }));
  }

  /** Las que SQS confirmo. `e6` es el instante en que lo confirmo. */
  async marcarEnviadas(ids: string[], e6: string): Promise<void> {
    if (ids.length === 0) return;
    await this.bd.pool.query(
      `UPDATE ${this.e}.outbox
          SET status = 'SENT', sent_at = $2::timestamptz, e6_publicado = $2::timestamptz
        WHERE id = ANY($1::bigint[])`,
      [ids, e6],
    );
    this.contadores.enviadas += ids.length;
  }

  /**
   * Las que fallaron. Se anota el error para que un FAILED sea accionable:
   * sin el codigo no distingues «AccessDenied cross-account» de «la red se
   * cayo tres veces», y son problemas opuestos.
   *
   * No se toca `next_attempt`: ya lo puso el reclamo. Volver a calcularlo
   * aqui daria un backoff doble.
   */
  async marcarFallo(ids: string[], codigo: string, detalle: string): Promise<void> {
    if (ids.length === 0) return;
    await this.bd.pool.query(
      `UPDATE ${this.e}.outbox
          SET last_error_code = $2, last_error = $3
        WHERE id = ANY($1::bigint[])`,
      [ids, codigo.slice(0, 120), detalle.slice(0, 500)],
    );
  }

  /**
   * Error PERMANENTE: directo a FAILED sin gastar los intentos que le quedan.
   *
   * Reintentar un `InvalidParameterValue` diez veces no lo arregla; solo
   * retrasa quince minutos el momento de enterarte.
   */
  async marcarFallidas(ids: string[], codigo: string, detalle: string): Promise<void> {
    if (ids.length === 0) return;
    await this.bd.pool.query(
      `UPDATE ${this.e}.outbox
          SET status = 'FAILED', last_error_code = $2, last_error = $3
        WHERE id = ANY($1::bigint[])`,
      [ids, codigo.slice(0, 120), detalle.slice(0, 500)],
    );
    this.contadores.fallidas += ids.length;
  }

  /**
   * Purgado horario (C-06).
   *
   * ⚠ NO corre en el mismo bucle que publica: borrar mientras publicas mete
   * contencion de vacuum justo bajo carga, que es cuando menos conviene.
   *
   * Y el paso a FAILED no es opcional: sin el, una fila que agoto sus
   * intentos se reintenta para siempre y el relay se atasca sobre el mismo
   * lote mientras la cola crece por detras.
   */
  async purgar(maxIntentos: number, horasRetencion = 2): Promise<{ borradas: number; fallidas: number }> {
    const borradas = await this.bd.pool.query(
      `DELETE FROM ${this.e}.outbox
        WHERE status = 'SENT' AND sent_at < now() - ($1 || ' hours')::interval`,
      [String(horasRetencion)],
    );
    const fallidas = await this.bd.pool.query(
      `UPDATE ${this.e}.outbox
          SET status = 'FAILED',
              last_error_code = coalesce(last_error_code, 'MaxAttempts')
        WHERE status = 'PENDING' AND attempts >= $1`,
      [maxIntentos],
    );
    return { borradas: borradas.rowCount ?? 0, fallidas: fallidas.rowCount ?? 0 };
  }

  /** Conteos para `GET /status` y para conciliar contra el inbox de C4. */
  async resumen(): Promise<Record<string, number>> {
    const { rows } = await this.bd.pool.query<Record<string, string>>(
      `SELECT
         (SELECT count(*) FROM ${this.e}.outbox)                                AS total,
         (SELECT count(*) FROM ${this.e}.outbox WHERE status = 'PENDING')       AS pendientes,
         (SELECT count(*) FROM ${this.e}.outbox WHERE status = 'SENT')          AS enviados,
         (SELECT count(*) FROM ${this.e}.outbox WHERE status = 'FAILED')        AS fallidos,
         (SELECT count(DISTINCT payload_hash) FROM ${this.e}.outbox)            AS payload_hash_unicos,
         (SELECT count(*) FROM ${this.e}.expediente)                            AS expedientes,
         (SELECT coalesce(max(attempts), 0) FROM ${this.e}.outbox)              AS intentos_max`,
    );
    const r = rows[0] ?? {};
    return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v)]));
  }
}

const msj = (e: unknown): string => (e instanceof Error ? e.message : String(e));
