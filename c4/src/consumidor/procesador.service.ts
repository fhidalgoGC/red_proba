import { Injectable, Logger } from '@nestjs/common';
import type { Message } from '@aws-sdk/client-sqs';
import { payloadHash, parsearSobre } from '../comun/sobre';
import { DescifradorService } from '../cripto/descifrador.service';
import { FirmaInvalida, LlaveNoAceptada, VerificadorService } from '../cripto/verificador.service';
import { InboxRepository, type EventoAPersistir } from '../bd/inbox.repository';
import { DlqService } from '../dlq/dlq.service';
import { MetricasService, ahora, msDesde } from '../metricas/metricas.service';

/**
 * Que hacer con el mensaje despues de procesarlo.
 *
 * `dejar` NO es un error suave: es la unica forma de que un fallo transitorio
 * -la base caida- vuelva a intentarse. Borrar en ese caso convertiria la
 * entrega en como-mucho-una-vez y la perdida dejaria de verse en P4.
 */
/**
 * `borrar` — el mensaje ya cumplio: persistido, duplicado o descartado a la DLQ.
 * `dejar`  — fallo transitorio: que venza el visibility timeout y se reentregue.
 * `diferir`— verificado y pendiente del COMMIT del lote (`C4_LOTE_TRANSACCION`).
 *            Solo el lazo sabe si acabara en `borrar` o en `dejar`.
 */
export type Accion = 'borrar' | 'dejar' | 'diferir';

export interface Resultado {
  accion: Accion;
  estado: 'persistido' | 'duplicado' | 'descartado' | 'reintentar' | 'diferido';
  payloadHash?: string;
  e10?: Date;
  motivo?: string;
  /**
   * Solo con `C4_LOTE_TRANSACCION`: el evento ya descifrado y verificado, que
   * el lazo persistira junto con el resto del lote en una sola transaccion.
   *
   * Va aqui y no en la base porque la decision de cuando escribir deja de ser
   * del procesador: el que sabe cuantos mensajes hay que meter en el mismo
   * COMMIT es quien tiene el lote entero.
   */
  diferido?: EventoAPersistir;
  /** Marcas monotonas para poder cerrar los tramos DESPUES del commit del lote. */
  relojes?: { tHash: bigint; t7b: bigint; canonicoLen: number };
}

@Injectable()
export class ProcesadorService {
  private readonly logger = new Logger('procesador');

  readonly contadores = {
    persistidos: 0,
    duplicados: 0,
    descartados: 0,
    reintentar: 0,
    con_alarma: 0,
  };

  constructor(
    private readonly descifrador: DescifradorService,
    private readonly verificador: VerificadorService,
    private readonly inbox: InboxRepository,
    private readonly dlq: DlqService,
    private readonly metricas: MetricasService,
  ) {}

  /**
   * @param t7     el gemelo MONOTONO de `e7`. Los tramos se miden con `hrtime`
   *               y no restando dos ISO: verificar Ed25519 sobre 3 KB es
   *               sub-milisegundo y la resta de dos marcas con resolucion de
   *               milisegundo lo daria en 0, con el informe diciendo que
   *               verificar es gratis.
   * @param prueba el id de corrida, ya normalizado por el lazo. Sale del
   *               `MessageAttribute` que escribio el relay de C3 copiando el
   *               `x-prueba-id` del orquestador. Llega resuelto y no se vuelve
   *               a leer aqui: dos sitios normalizando el mismo dato es un
   *               archivo escrito con un nombre y buscado con otro.
   */
  async procesar(
    mensaje: Message,
    e7: Date,
    t7: bigint,
    prueba: string,
    /**
     * No escribir: devolver el evento listo para que el lazo lo meta en el
     * COMMIT del lote (`C4_LOTE_TRANSACCION`).
     *
     * ⚠ Todo lo de ANTES -descifrar, verificar, la DLQ del veneno- se hace
     *   igual. Lo unico que se aplaza es el asiento, que es lo unico que se
     *   puede agrupar sin cambiar lo que se comprueba.
     */
    diferirPersistencia = false,
  ): Promise<Resultado> {
    // e7b · "a este mensaje le toca". Lo que va de e7 a aqui es espera dentro
    // del lote, no trabajo — y confundir las dos cosas haria que P3 senalara
    // al descifrado como el componente que se satura.
    const e7b = new Date();
    const t7b = ahora();
    // `wait` se anota con `paso` (abre+cierra juntos) porque es un hueco entre
    // dos instantes que YA pasaron: no hay un "empezo" que situar en un
    // segundo distinto del "termino".
    this.metricas.paso(prueba, 'wait', msDesde(t7, t7b));

    const cuerpo = mensaje.Body ?? '';
    const attrs = mensaje.Attributes ?? {};
    const bytesSobre = Buffer.byteLength(cuerpo, 'utf8');
    const grupo = attrs.MessageGroupId ?? '';
    const hashDeclarado = attrs.MessageDeduplicationId ?? '';
    const recepciones = Number(attrs.ApproximateReceiveCount ?? 1) || 1;
    const enviado = Number(attrs.SentTimestamp);

    // `message` cubre e7b→e10: el trabajo del mensaje, sin la espera del lote.
    //
    // ⚠ SOLO SE CIERRA EN EL CAMINO COMPLETO (persistido o duplicado). Un
    // veneno o un reintento dejan `init` sin `completed`, y ese hueco es el
    // dato: `message.init - message.completed` = descartados + reintentados +
    // reventados. Cerrarlo tambien ahi meteria en `message.suma_ms` mensajes
    // que no hicieron el trabajo entero, y `envelope + decrypt + verify + hash
    // + inbox = message` dejaria de cuadrar.
    this.metricas.empieza(prueba);

    const veneno = (motivo: string, detalle: string, hash: string | null = null): Promise<Resultado> =>
      this.envenenado({
        cuerpo, grupo, hashDeclarado, motivo, detalle, prueba, hash,
        messageId: mensaje.MessageId ?? null, bytesSobre, recepciones, e7,
      });

    // ── 1. ¿Es un sobre? ──
    // Se mira la envoltura antes de gastar una llamada a KMS. Un cuerpo que
    // no es un sobre no merece un Decrypt, y distinguir "esto no es mio" de
    // "esto no descifra" separa un error de configuracion de una inyeccion.
    let sobre;
    this.metricas.abre(prueba, 'envelope');
    try {
      sobre = parsearSobre(cuerpo);
    } catch (e) {
      return veneno('no_es_sobre', msj(e));
    }
    const tEnvelope = ahora();
    this.metricas.cierra(prueba, 'envelope', msDesde(t7b, tEnvelope));

    // ── 2. Descifrar (G-02) → e8 ──
    let contenido;
    // Las llamadas a KMS se cuentan por DIFERENCIA sobre los contadores del
    // servicio, no instrumentandolo por dentro: el descifrador no sabe de
    // corridas y no tiene por que. Lo que importa no es el tiempo sino la
    // razon — si `decrypt` crece al ritmo de los mensajes, el cache de data
    // key dejo de acertar y el cuello se muda a KMS.
    const kms0 = { ...this.descifrador.contadores };
    this.metricas.abre(prueba, 'decrypt');
    try {
      contenido = await this.descifrador.descifrar(sobre);
    } catch (e) {
      this.anotarKms(prueba, kms0);
      return veneno('no_descifra', msj(e));
    }
    const e8 = new Date();
    const tDecrypt = ahora();
    this.metricas.cierra(prueba, 'decrypt', msDesde(tEnvelope, tDecrypt));
    this.anotarKms(prueba, kms0);

    // ── 3. Verificar la firma (G-02) → e9 ──
    // En este orden y no al reves: no se puede verificar lo que todavia no se
    // puede leer. Y se firma antes de cifrar (regla 6), asi que al abrir el
    // sobre la firma esta ahi dentro, cubriendo el documento.
    let canonico: Buffer;
    const pub0 = this.verificador.contadores.get_public_key;
    this.metricas.abre(prueba, 'verify');
    try {
      ({ canonico } = await this.verificador.verificar(
        contenido.payload,
        contenido.signature,
        sobre.key_id,
      ));
    } catch (e) {
      this.metricas.kms(prueba, { pubkey: this.verificador.contadores.get_public_key - pub0 });
      if (e instanceof LlaveNoAceptada) return veneno('llave_no_aceptada', msj(e));
      if (e instanceof FirmaInvalida) {
        // El caso mas grave de los dos que enumera G-07: descifro pero no
        // verifica. Significa que alguien con la llave de cifrado intento
        // inyectar. No es un reintento, es una alarma.
        return veneno('firma_invalida', msj(e));
      }
      // No pudo verificarse por otra causa -KMS no contesta, por ejemplo-.
      // Eso NO es veneno: es transitorio y merece reintento.
      this.contadores.reintentar += 1;
      this.metricas.mensaje(prueba, 'reintentar');
      this.logger.warn(`no se pudo verificar (transitorio), se deja en cola: ${msj(e)}`);
      return { accion: 'dejar', estado: 'reintentar', motivo: msj(e) };
    }
    const e9 = new Date();
    const tVerify = ahora();
    this.metricas.cierra(prueba, 'verify', msDesde(tDecrypt, tVerify));
    this.metricas.kms(prueba, { pubkey: this.verificador.contadores.get_public_key - pub0 });

    const p = contenido.payload;

    // `rpf_id` es UUID en el inbox. Uno mal formado hace que Postgres rechace
    // la INSERT, y sin esta guarda ese rechazo se leeria como fallo
    // transitorio: el mensaje volveria a la cola y se reintentaria para
    // siempre. Un dato invalido no mejora con el tiempo — es veneno.
    const rpfId = uuid(p.rpf_id);
    if (!rpfId) {
      return veneno('rpf_id_invalido', `rpf_id=${JSON.stringify(p.rpf_id)} no es un UUID`);
    }

    // ── 4. Lo que dice el sobre por fuera tiene que ser lo que dice por dentro ──
    //
    // Los atributos del mensaje viajan EN CLARO y los escribio quien publico.
    // Si `MessageGroupId` no es el `rpf_id` firmado, el orden FIFO se estaria
    // manteniendo sobre un expediente distinto del que dice el documento, y
    // G-05 mediria huecos de un agrupamiento que no existe.
    if (grupo && rpfId && grupo !== rpfId) {
      return veneno('rpf_id_no_coincide', `MessageGroupId=${grupo} pero el payload dice ${rpfId}`);
    }

    // Y el payload_hash se RECALCULA, no se cree. Es la clave primaria del inbox:
    // aceptar el que venga declarado dejaria la idempotencia en manos del
    // emisor. Si no coincide, o el emisor mintio o los dos lados canonizan
    // distinto — y esa segunda es la deriva del JCS, que si pasa inadvertida
    // rompe la firma de todos los eventos siguientes.
    //
    // Recanonizar 3 KB no es gratis y por eso lleva tramo propio: si `hash`
    // sube con el tamano del payload, el cuello es CPU y no red, y eso cambia
    // la respuesta a P3.
    this.metricas.abre(prueba, 'hash');
    const hash = payloadHash(p);
    const tHash = ahora();
    this.metricas.cierra(prueba, 'hash', msDesde(tVerify, tHash));

    if (hashDeclarado && hashDeclarado !== hash) {
      return veneno(
        'payload_hash_no_coincide',
        `declarado=${hashDeclarado} recalculado=${hash} · o el emisor mintio o el JCS derivo`,
        hash,
      );
    }

    // ── 5. Persistir (G-03 + G-04) → e10 ──
    const aPersistir: EventoAPersistir = {
        payloadHash: hash,
        rpfId,
        sequence: Number(p.sequence ?? 0) || 0,
        eventId: uuid(p.event_id),
        eventType: texto(p.event_type),
        schemaVersion: texto(p.schema_version),
        partyId: texto(p.party_id),
        keyId: sobre.key_id,
        sigAlg: sobre.sig_alg,
        occurredAt: fecha(p.occurred_at),
        messageId: mensaje.MessageId ?? null,
        recepciones,
        bytesSobre,
        bytesCanonicos: canonico.length,
        sqsEnviado: Number.isFinite(enviado) ? new Date(enviado) : null,
        prueba,
        e7, e7b, e8, e9,
        payload: p,
    };

    // Modo diferido: el trabajo criptografico ya esta hecho y verificado; lo
    // que falta es el asiento, y ese lo hace el lazo con el lote entero. Los
    // tramos `inbox` y `message` NO se abren aqui: se abriran y cerraran
    // alrededor del COMMIT del lote, que es donde de verdad transcurre.
    if (diferirPersistencia) {
      return {
        accion: 'diferir',
        estado: 'diferido',
        payloadHash: hash,
        diferido: aPersistir,
        relojes: { tHash, t7b, canonicoLen: canonico.length },
      };
    }

    this.metricas.abre(prueba, 'inbox');
    try {
      const r = await this.inbox.persistir(aPersistir);

      const tInbox = ahora();
      this.metricas.cierra(prueba, 'inbox', msDesde(tHash, tInbox));
      this.metricas.cierra(prueba, 'message', msDesde(t7b, tInbox));

      if (r.nuevo) {
        this.contadores.persistidos += 1;
        this.metricas.mensaje(prueba, 'persistido', hash, canonico.length);
        return { accion: 'borrar', estado: 'persistido', payloadHash: hash, e10: r.e10 };
      }
      // Duplicado. Es funcionamiento normal, no anomalia (regla 4): el relay
      // reintento. Se cuenta y se borra.
      this.contadores.duplicados += 1;
      this.metricas.mensaje(prueba, 'duplicado', hash, canonico.length);
      return { accion: 'borrar', estado: 'duplicado', payloadHash: hash };
    } catch (e) {
      // TRANSITORIO. No se borra: que venza el visibility timeout y SQS lo
      // reentregue. A las 5 recepciones el redrive_policy lo manda solo a la
      // DLQ, sin que C4 tenga que decidir nada.
      //
      // `inbox` y `message` se quedan con `init` y sin `completed`: en el log
      // eso es lo que dice que el mensaje se atasco EN LA BASE y no antes.
      this.contadores.reintentar += 1;
      this.metricas.mensaje(prueba, 'reintentar', hash);
      this.logger.error(`no se pudo persistir ${hash.slice(0, 12)}, se deja en cola: ${msj(e)}`);
      return { accion: 'dejar', estado: 'reintentar', payloadHash: hash, motivo: msj(e) };
    }
  }

  /** Las llamadas a KMS que se gastaron desde el corte, por diferencia. */
  private anotarKms(prueba: string, antes: { decrypt: number; cache_hit: number }): void {
    const c = this.descifrador.contadores;
    this.metricas.kms(prueba, {
      decrypt: c.decrypt - antes.decrypt,
      cache: c.cache_hit - antes.cache_hit,
    });
  }

  /** Los casos de G-07 que van a la DLQ a mano, con alarma. */
  private async envenenado(v: {
    cuerpo: string; grupo: string; hashDeclarado: string; motivo: string; detalle: string;
    messageId: string | null; bytesSobre: number; recepciones: number; e7: Date;
    prueba: string; hash: string | null;
  }): Promise<Resultado> {
    this.contadores.descartados += 1;
    this.contadores.con_alarma += 1;
    // `hash` solo existe si el veneno se detecto DESPUES de recanonizar. Los
    // que ni llegaron a tener uno -no era un sobre, no descifro- no cuentan
    // como payload_hash unico ni repetido: eso los mezclaria con trafico
    // legitimo. Se cuentan en `discarded`, que es lo que son.
    this.metricas.mensaje(v.prueba, 'descartado', v.hash);

    // El camino del veneno se cronometra APARTE del pipeline: publicar en la
    // DLQ y anotar el descarte son dos viajes de red que no le pasan a un
    // mensaje sano. Metidos en `message` inflarian la latencia media con un
    // trabajo que solo ocurre cuando algo va mal — y una corrida con seis
    // venenos parecerian seis mensajes lentos.
    const tDlq = ahora();
    this.metricas.abre(v.prueba, 'dlq');

    this.logger.error(
      `⚠ ALARMA · ${v.motivo} · msg=${v.messageId ?? '?'} grupo=${v.grupo || '?'} · ${v.detalle}`,
    );

    // Publicar ANTES de borrar. Al reves, un crash entre las dos operaciones
    // pierde la evidencia — y la evidencia es todo lo que este camino produce.
    const aLaDlq = await this.dlq.mandar({
      cuerpo: v.cuerpo,
      // La DLQ es FIFO y exige los dos campos. Si el mensaje venia sin ellos
      // -el caso "esto no es un sobre"- hay que inventar algo estable: el
      // MessageId sirve, es unico y no se repite.
      rpfId: v.grupo || `sin-grupo-${v.messageId ?? 'x'}`,
      payloadHash: v.hashDeclarado || `sin-hash-${v.messageId ?? 'x'}`,
      messageId: v.messageId,
      motivo: v.motivo,
      detalle: v.detalle,
      e7: v.e7,
    });

    await this.inbox.anotarDescarte({
      payloadHash: v.hashDeclarado || null,
      rpfId: v.grupo || null,
      messageId: v.messageId,
      motivo: v.motivo,
      alarma: true,
      detalle: v.detalle,
      bytesSobre: v.bytesSobre,
      recepciones: v.recepciones,
      prueba: v.prueba,
      aLaDlq,
      e7: v.e7,
    });

    this.metricas.cierra(v.prueba, 'dlq', msDesde(tDlq));
    if (aLaDlq) this.metricas.dlq(v.prueba);

    // Se borra de la principal en el acto: es veneno determinista y dejarlo
    // congelaria la cabeza de su grupo FIFO durante 5 minutos.
    return { accion: 'borrar', estado: 'descartado', motivo: v.motivo };
  }
}

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Postgres rechaza un uuid mal formado y tumbaria la transaccion entera. */
function uuid(v: unknown): string | null {
  return typeof v === 'string' && RE_UUID.test(v) ? v : null;
}
function texto(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}
/**
 * Igual que con el uuid: una fecha que Postgres no sabe leer aborta la
 * transaccion, y el aborto se confundiria con "la base esta caida" — que se
 * reintenta. Se normaliza aqui o se guarda null.
 */
function fecha(v: unknown): string | null {
  if (typeof v !== 'string' || v === '') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
function msj(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
