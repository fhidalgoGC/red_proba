import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
import { ConfigService } from '../config/config.service';
import { esquemaSql } from './esquema';

/**
 * El pool de Postgres de C4 y el arranque del esquema.
 *
 * Un pool para todo el proceso: el consumidor procesa un mensaje a la vez por
 * ciclo, asi que lo que importa no es el paralelismo sino que la conexion NO
 * se abra por evento. Con conexion por evento, el tramo e9→e10 mediria el
 * handshake de Postgres y no la persistencia.
 */
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
      // Sin esto, una base que deja de responder cuelga el consumidor sin un
      // solo error en el log: el mensaje se queda en vuelo, vence el
      // visibility timeout y reaparece. Se veria como duplicados, no como
      // base caida.
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
    await this.pool.end().catch(() => undefined);
  }

  /** ¿Contesta la base? C-08 del lado de C4: un health fijo no avisa de nada. */
  async viva(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Una transaccion. El ROLLBACK va en el catch y no en un finally: en el
   * finally correria tambien despues del COMMIT y el error que veria quien
   * llama seria "no hay transaccion en curso" en vez del error real.
   */
  async enTransaccion<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const cliente = await this.pool.connect();
    try {
      await cliente.query('BEGIN');
      const r = await fn(cliente);
      await cliente.query('COMMIT');
      return r;
    } catch (e) {
      await cliente.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      cliente.release();
    }
  }
}
