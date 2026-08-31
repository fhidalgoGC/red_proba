import { Injectable, Logger, OnModuleInit, OnApplicationShutdown } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Pool } from 'undici';
import { ConfigService } from '../config/config.service';
import { CorridaService } from '../corrida/corrida.service';
import type { Tenant } from '../config/tipos';
import type { Documento } from '../generador/payload';
import { ManifiestoService } from '../metricas/manifiesto.service';
import { MetricasService } from '../metricas/metricas.service';

/**
 * O-05 — Cliente HTTP con pool y timeouts explicitos.
 *
 * 50 destinos, conexiones reutilizadas, timeout corto. Sin timeout, un tenant
 * colgado bloquea el planificador y deforma la carga ofrecida al RESTO de los
 * tenants: terminarias midiendo el sistema mas lento, no el sistema.
 *
 * O-02 — Lazo abierto. `enviar()` NO devuelve una promesa que el planificador
 * espere. Dispara y sigue. Si esperara la respuesta, un tenant lento recibiria
 * menos carga y mediria un sistema que se ve sano porque nadie lo esta
 * presionando — omision coordinada, la forma mas comun de que una prueba de
 * carga mienta.
 */
@Injectable()
export class EmisorService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(EmisorService.name);

  private readonly pools = new Map<string, Pool>();
  private readonly enVuelo = new Map<string, number>();
  private cerrando = false;

  constructor(
    private readonly config: ConfigService,
    private readonly corrida: CorridaService,
    private readonly metricas: MetricasService,
    private readonly manifiesto: ManifiestoService,
  ) {}

  onModuleInit(): void {
    this.construir(this.config.perfil.envio.conexionesPorDestino, this.config.perfil.envio.timeoutMs);
  }

  /**
   * Rehace los pools HTTP con otro numero de conexiones.
   *
   * ⚠ LAS CONEXIONES SON UN TECHO DURO DE RITMO, no un detalle de tuning.
   *
   * Por la ley de Little, el ritmo maximo que un pool puede sostener es
   * `conexiones / latencia`. Con 32 conexiones y un destino que tarda 0,8 s,
   * el techo son 40 req/s — por muchos que pidas. Todo lo que exceda ese
   * numero se queda esperando y acaba descartado por saturacion, y el informe
   * lo acusaria al destino cuando el cuello estaba en el emisor.
   */
  reconfigurar(conexiones: number, timeoutMs: number): void {
    for (const p of this.pools.values()) void p.close().catch(() => undefined);
    this.pools.clear();
    this.construir(conexiones, timeoutMs);
  }

  private construir(conexionesPorDestino: number, timeoutMs: number): void {
    this._conexiones = conexionesPorDestino;
    for (const t of this.config.tenants) {
      this.pools.set(t.id, new Pool(t.url, {
        connections: conexionesPorDestino,
        // Sin pipelining: con FIFO por detras, encolar requests en la misma
        // conexion añade una cola invisible que no controlas y que ensucia
        // la latencia que mides.
        pipelining: 1,
        keepAliveTimeout: 30_000,
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
      }));
      this.enVuelo.set(t.id, 0);
    }

    this.logger.log(
      `emisor listo: ${this.pools.size} destinos, ${conexionesPorDestino} conexiones c/u, ` +
      `timeout ${timeoutMs} ms · techo teorico ${conexionesPorDestino} / latencia req/s`,
    );
  }

  get conexiones(): number { return this._conexiones; }
  private _conexiones = 0;

  async onApplicationShutdown(): Promise<void> {
    this.cerrando = true;
    await Promise.all([...this.pools.values()].map((p) => p.close().catch(() => undefined)));
  }

  /**
   * Dispara un lote. NO se espera: devuelve en cuanto la request esta en vuelo.
   *
   * @returns false si el lote se descarto por saturacion del tope en vuelo.
   */
  enviar(tenant: Tenant, documentos: Documento[], bytes: number): boolean {
    if (documentos.length === 0) return true;
    if (this.cerrando) {
      this.metricas.descartadosSaturacion(tenant.id, documentos.length);
      this.manifiesto.noEmitidos(tenant.id, documentos, 'saturacion');
      return false;
    }

    const { concurrenciaPorTenant, ruta, timeoutMs, pruebaId } = this.corrida.perfil.envio;
    const actual = this.enVuelo.get(tenant.id) ?? 0;

    // concurrenciaPorTenant === 0 significa SIN TOPE: el reloj manda y no se
    // descarta nada. Ver la nota de O-02 en corrida.service.ts.
    if (concurrenciaPorTenant > 0 && actual >= concurrenciaPorTenant) {
      // Esto NO es un error del arnes: es la señal de que el tenant no drena
      // tan rapido como se le ofrece. Se cuenta aparte para que el reporte
      // pueda distinguirlo de un rechazo explicito.
      this.metricas.descartadosSaturacion(tenant.id, documentos.length);
      this.manifiesto.noEmitidos(tenant.id, documentos, 'saturacion');
      return false;
    }

    const n = documentos.length;
    const loteId = randomUUID();
    const cuerpo = JSON.stringify({ lote_id: loteId, tenant_id: tenant.id, documentos });

    this.enVuelo.set(tenant.id, actual + 1);
    this.metricas.enVuelo(1);
    this.metricas.enviados(tenant.id, n, bytes);
    // O-08 · aqui, y no antes, es donde el evento SALE POR EL CABLE. Anotarlo
    // en el planificador contaria como emitido lo que solo estaba planificado.
    this.manifiesto.emitidos(tenant.id, documentos);

    const t0 = performance.now();
    const pool = this.pools.get(tenant.id)!;

    pool.request({
      path: ruta,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-lote-id': loteId,
        'x-tenant-id': tenant.id,
        'x-eventos': String(n),
        // Marca de corrida. C3 agrupa sus logs por esto; sin ella las
        // peticiones de dos pruebas distintas se mezclan en el mismo minuto.
        ...(pruebaId ? { 'x-prueba-id': pruebaId } : {}),
      },
      body: cuerpo,
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    }).then(async (res) => {
      // Hay que drenar el cuerpo aunque no lo mires: dejarlo sin consumir
      // retiene la conexion del pool y a los pocos miles de requests el
      // emisor se queda sin conexiones y falsea la saturacion.
      await res.body.dump();

      // COMPLETED es "hubo respuesta", sea cual sea el codigo. El desglose
      // 2xx / no-2xx lo hace MetricasService.
      this.metricas.completados(tenant.id, n, bytes, performance.now() - t0, res.statusCode);
      // Solo un 2xx convierte el evento en exigible: es lo que permite decir
      // "esto lo aceptaron y no esta en C4" en vez de "esto no aparece".
      this.manifiesto.resueltos(
        documentos,
        res.statusCode >= 200 && res.statusCode < 300 ? 'aceptado' : 'rechazado',
      );
    }).catch((e: unknown) => {
      const causa = (e as { code?: string; name?: string; message?: string });
      this.metricas.fallidos(tenant.id, n, causa.code ?? causa.name ?? 'desconocido');
      this.manifiesto.resueltos(documentos, 'fallido');
    }).finally(() => {
      // El finally no es opcional: sin el, una excepcion deja el contador de
      // en-vuelo inflado para siempre y el emisor se declara saturado a si
      // mismo mientras el tenant esta ocioso.
      this.enVuelo.set(tenant.id, (this.enVuelo.get(tenant.id) ?? 1) - 1);
      this.metricas.enVuelo(-1);
    });

    return true;
  }

  enVueloDe(tenantId: string): number { return this.enVuelo.get(tenantId) ?? 0; }
}
