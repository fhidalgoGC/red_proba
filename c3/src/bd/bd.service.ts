/**
 * El pool de Postgres del tenant y el arranque del esquema.
 *
 * UN pool para todo el proceso. Con conexion por evento, el tramo e3→e4
 * mediria el handshake de Postgres en vez de la escritura — y e3→e4 es
 * justamente uno de los tramos que la PoC quiere separar.
 *
 * Mismo diseño que `c4/src/bd/bd.service.ts`, a proposito: son dos dominios
 * distintos pero el problema es el mismo, y dos soluciones distintas para el
 * mismo problema solo dan dos sitios donde equivocarse.
 */
import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
import { ConfigService } from '../config/config.service';
import { esquemaSql } from './esquema';

@Injectable()
export class BdService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('bd');
  readonly pool: Pool;
  readonly esquema: string;

  constructor(private readonly config: ConfigService) {
    this.esquema = config.bdEsquema;
    this.pool = new Pool({
      connectionString: config.bdUrl,
      max: config.bdPoolMax,
      // Sin esto, una base que deja de responder cuelga las peticiones sin un
      // solo error en el log: el orquestador veria timeouts y los contaria
      // como saturacion del contenedor, que es la conclusion equivocada.
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
    });
    this.pool.on('error', (e) => this.logger.error(`pool: ${e.message}`));
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.pool.query(esquemaSql(this.esquema));
    const { rows } = await this.pool.query<{ v: string }>('SELECT version() AS v');
    this.logger.log(`esquema "${this.esquema}" listo · ${rows[0]?.v.split(',')[0] ?? '?'}`);
  }

  async onApplicationShutdown(): Promise<void> {
    // C-07: cerrar el pool al final del apagado, cuando ya no queda nada en
    // vuelo. `end()` espera a que las conexiones activas terminen.
    await this.pool.end().catch(() => undefined);
  }

  /** ¿Contesta la base? C-08 pide que el health toque esto de verdad. */
  async viva(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Una transaccion.
   *
   * El ROLLBACK va en el `catch` y no en un `finally`: en el finally correria
   * tambien despues del COMMIT, y el error que veria quien llama seria «no hay
   * transaccion en curso» en vez del error real que causo el fallo.
   */
  async enTransaccion<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }
}
