import { Injectable, Logger, Optional } from '@nestjs/common';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { aRangos, contar } from '../conciliacion/rangos';
import type { ExpedienteManifiesto, Manifiesto } from '../conciliacion/tipos';

/**
 * O-08 · El manifiesto de expedientes: que `(rpf_id, sequence)` salio de aqui.
 *
 * ────────────────────────────────────────────────────────────────────────
 * POR QUE EXISTE
 *
 * El orquestador es el unico que sabe la verdad sobre lo que se emitio: el
 * decide `rpf_id` y `sequence` (ver planificador/hilos.ts). C4 solo puede
 * mirar lo que le llego, y desde ahi no se distingue «llego completo» de
 * «llegaron los primeros y se corto»: si falta la cola, el MAX se desplaza y
 * el rango sigue pareciendo denso.
 *
 * Con este archivo, P4 deja de ser «conte 2.457 filas y me cuadra» y pasa a
 * ser «estos ids salieron, estos llegaron, estos faltan».
 *
 * ⚠ LA REGLA: aqui se registra lo que SALIO POR EL CABLE, no lo que se
 * planifico. Las secuencias se asignan con segundos de antelacion; un evento
 * planificado que nunca se dispara se lleva su `sequence` a la tumba. Si eso
 * figurara como emitido, la conciliacion acusaria a C3 de perder un evento que
 * no existio. Por eso `noEmitidos()` no es un detalle de contabilidad: es lo
 * que separa un hueco del sistema de un hueco del arnes.
 *
 * COSTE. Un objeto por expediente, con arrays de enteros pequeños dentro
 * (`eventos_por_hilo` suele ser 10). En el perfil grande —25 millones de
 * eventos, 2,5 millones de expedientes— eso son cientos de MB, asi que hay un
 * tope explicito. Al alcanzarlo se dejan de admitir expedientes NUEVOS y el
 * manifiesto sale con `truncado: true`: un recorte silencioso se leeria como
 * «esos expedientes no existieron» y la conciliacion daria un cero limpio
 * sobre datos a medias.
 * ────────────────────────────────────────────────────────────────────────
 */

/** Lo minimo que hace falta de un documento para anotarlo. */
export interface Identidad {
  rpf_id: string;
  sequence: number;
}

export type Resolucion = 'aceptado' | 'rechazado' | 'fallido';
export type MotivoNoEmitido = 'retraso' | 'saturacion';

/** Expedientes distintos que se guardan antes de empezar a omitir. */
const TOPE_EXPEDIENTES = Number(process.env.ORQ_MANIFIESTO_TOPE ?? 200_000);

interface Fila {
  tenant: string;
  emitidos: number[];
  aceptados: number[];
  rechazados: number[];
  fallidos: number[];
  noEmitidos: number[];
}

@Injectable()
export class ManifiestoService {
  private readonly logger = new Logger('manifiesto');

  private filas = new Map<string, Fila>();
  private omitidos = new Set<string>();
  private retraso = 0;
  private saturacion = 0;
  private avisoTope = false;

  // `@Optional` porque el tope no es una dependencia inyectable: Nest no sabe
  // resolver un `number` y sin esto el modulo entero fallaria al arrancar. Los
  // tests lo pasan a mano; en produccion manda ORQ_MANIFIESTO_TOPE.
  constructor(@Optional() private readonly tope: number = TOPE_EXPEDIENTES) {}

  reiniciar(): void {
    this.filas = new Map();
    this.omitidos = new Set();
    this.retraso = 0;
    this.saturacion = 0;
    this.avisoTope = false;
  }

  /** Entraron en el cuerpo de una peticion. */
  emitidos(tenantId: string, docs: readonly Identidad[]): void {
    for (const d of docs) {
      const f = this.fila(d.rpf_id, tenantId);
      if (f) f.emitidos.push(d.sequence);
    }
  }

  /** Contesto el destino (o no contesto nadie). */
  resueltos(docs: readonly Identidad[], r: Resolucion): void {
    for (const d of docs) {
      // Sin tenant: si el expediente no existe ya, es que se omitio por el
      // tope. Crearlo aqui lo resucitaria a medias, con la resolucion pero sin
      // lo que se emitio, y el expediente parecerian puras perdidas.
      const f = this.filas.get(d.rpf_id);
      if (!f) continue;
      if (r === 'aceptado') f.aceptados.push(d.sequence);
      else if (r === 'rechazado') f.rechazados.push(d.sequence);
      else f.fallidos.push(d.sequence);
    }
  }

  /**
   * Se planifico y nunca salio.
   *
   * `retraso` acusa al ARNES: el planificador no alcanzo a disparar la cuota
   * del segundo. `saturacion` dice que el tope de peticiones en vuelo del
   * tenant estaba lleno — eso es señal sobre el destino, no error del arnes.
   * Mezclarlos borraria la distincion que O-06 existe para sostener.
   */
  noEmitidos(tenantId: string, docs: readonly Identidad[], motivo: MotivoNoEmitido): void {
    for (const d of docs) {
      const f = this.fila(d.rpf_id, tenantId);
      if (f) f.noEmitidos.push(d.sequence);
      if (motivo === 'retraso') this.retraso++; else this.saturacion++;
    }
  }

  // -------------------------------------------------------------------------

  construir(prueba: string): Manifiesto {
    const expedientes: ExpedienteManifiesto[] = [];
    const t = {
      expedientes: 0, emitidos: 0, aceptados: 0, rechazados: 0, fallidos: 0,
      en_vuelo: 0, no_emitidos_retraso: this.retraso, no_emitidos_saturacion: this.saturacion,
    };

    for (const [rpfId, f] of this.filas) {
      const e: ExpedienteManifiesto = {
        rpf_id: rpfId,
        tenant: f.tenant,
        emitidos: aRangos(f.emitidos),
        aceptados: aRangos(f.aceptados),
        rechazados: aRangos(f.rechazados),
        fallidos: aRangos(f.fallidos),
        no_emitidos: aRangos(f.noEmitidos),
      };
      expedientes.push(e);

      t.expedientes++;
      t.emitidos += contar(e.emitidos);
      t.aceptados += contar(e.aceptados);
      t.rechazados += contar(e.rechazados);
      t.fallidos += contar(e.fallidos);
    }

    // En vuelo = salio y nadie contesto. Se deriva en vez de contarse aparte
    // para que no pueda quedar descuadrado con el resto.
    t.en_vuelo = t.emitidos - t.aceptados - t.rechazados - t.fallidos;

    return {
      prueba,
      generado: new Date().toISOString(),
      truncado: this.omitidos.size > 0,
      expedientes_omitidos: this.omitidos.size,
      totales: t,
      expedientes,
    };
  }

  /**
   * Escritura atomica: temporal + rename, igual que el informe de la corrida.
   * Un manifiesto a medio escribir se leeria como un manifiesto con huecos.
   */
  volcar(dir: string, prueba: string): string | null {
    const destino = join(dir, `${prueba}__manifiesto.json`);
    const temporal = destino + '.tmp';

    try {
      mkdirSync(dir, { recursive: true });
      const m = this.construir(prueba);
      writeFileSync(temporal, JSON.stringify(m, null, 2) + '\n', 'utf8');
      renameSync(temporal, destino);
      this.logger.log(
        `[${prueba}] ${m.totales.expedientes} expediente(s) · ` +
        `emitidos ${m.totales.emitidos} · aceptados ${m.totales.aceptados} · ` +
        `no emitidos ${m.totales.no_emitidos_retraso + m.totales.no_emitidos_saturacion} · ${destino}`,
      );
      return destino;
    } catch (e) {
      // Que no se pueda escribir el manifiesto no debe tumbar la corrida.
      this.logger.error(`no se pudo escribir ${destino}: ${(e as Error).message}`);
      return null;
    }
  }

  // -------------------------------------------------------------------------

  private fila(rpfId: string, tenantId: string): Fila | null {
    const ya = this.filas.get(rpfId);
    if (ya) return ya;

    if (this.filas.size >= this.tope) {
      this.omitidos.add(rpfId);
      if (!this.avisoTope) {
        this.avisoTope = true;
        this.logger.warn(
          `tope de ${this.tope} expedientes alcanzado: el manifiesto saldra truncado. ` +
          `Sube ORQ_MANIFIESTO_TOPE o baja la duracion de la corrida.`,
        );
      }
      return null;
    }

    const f: Fila = {
      tenant: tenantId,
      emitidos: [], aceptados: [], rechazados: [], fallidos: [], noEmitidos: [],
    };
    this.filas.set(rpfId, f);
    return f;
  }
}
