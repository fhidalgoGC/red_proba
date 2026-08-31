import {
  DeleteMessageBatchCommand,
  Message,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import { InboxRepository } from '../bd/inbox.repository';
import { DescifradorService } from '../cripto/descifrador.service';
import { VerificadorService } from '../cripto/verificador.service';
import { DlqService } from '../dlq/dlq.service';
import { MetricasService, ahora, msDesde, normalizar } from '../metricas/metricas.service';
import { ProcesadorService, type Resultado } from './procesador.service';

/**
 * G-01 · consumidor FIFO con long polling.
 *
 * Un lazo `while` con `await`, no un `setInterval`: con intervalo, dos ciclos
 * se solaparian en cuanto uno tarde mas que el periodo y el mismo mensaje se
 * procesaria dos veces por una razon que no es el contrato de
 * al-menos-una-vez, sino un bug propio.
 *
 * ⚠ Limite de 20.000 mensajes en vuelo en una cola FIFO. Si C4 se atrasa, la
 * cola deja de entregar con OverLimit y el sintoma PARECE que se vacio,
 * cuando en realidad esta llena.
 */
@Injectable()
export class ConsumidorService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('consumidor');
  private readonly sqs: SQSClient;
  private readonly abort = new AbortController();

  private corriendo = false;
  /**
   * Guarda de cierre, SEPARADA de `corriendo`.
   *
   * ⚠ Antes esta guarda era el propio `corriendo`, y eso era un bug: cuando
   * el lazo paraba por su cuenta -C4_SALIR_TRAS_VACIOS, o cualquier salida
   * limpia- `corriendo` ya estaba en false, asi que el cierre se creia hecho,
   * volvia sin limpiar nada y el intervalo del resumen dejaba vivo el event
   * loop para siempre. En Fargate el sintoma habria sido un contenedor que
   * ignora el SIGTERM y muere a los 30 s por SIGKILL, en medio de un lote.
   */
  private cerrado = false;

  /**
   * Los lazos de recepcion vivos. Son `C4_CONCURRENCIA` invocaciones de
   * `lazoPrincipal()`, no uno con concurrencia dentro.
   *
   * ⚠ Un array y no una promesa suelta porque el cierre ordenado tiene que
   *   esperarlos a TODOS: salir con uno a medias deja mensajes persistidos y
   *   sin borrar, que reaparecen y se cuentan dos veces.
   */
  private lazos: Array<Promise<void>> = [];
  private resumen: NodeJS.Timeout | null = null;
  /**
   * Ciclos vacios seguidos, COMPARTIDO entre los N lazos.
   *
   * Compartido a proposito: la señal que interesa es "la cola esta drenada", y
   * eso es una propiedad de la cola, no de un lazo. Cualquier lazo que reciba
   * algo lo pone a cero.
   *
   * ⚠ Con N lazos, `C4_SALIR_TRAS_VACIOS` se alcanza antes en tiempo de reloj:
   *   son N sondeos vacios en total, no N por lazo. Es lo correcto para drenar
   *   -si ocho sondeos seguidos vuelven vacios, no queda nada- pero si alguien
   *   afina ese numero con un lazo y luego sube la concurrencia, la corrida se
   *   le cortara antes de lo que espera.
   */
  private vaciosSeguidos = 0;

  /**
   * La ultima corrida vista, para poder imputar lo que llega SIN mensajes: un
   * ciclo vacio y un `ReceiveMessage` que revienta.
   *
   * Los dos son datos de la corrida —"la cola se drena" y "la cola no
   * contesta"— pero no traen de donde sacar el id. Antes del primer mensaje
   * vale `undefined` y esos ciclos simplemente no se anotan: inventarle una
   * corrida a un sondeo en vacio dejaria en disco el log de una prueba que
   * nunca existio.
   */
  private pruebaEnCurso: string | undefined;

  /**
   * Se resuelve cuando el lazo para por si solo (C4_SALIR_TRAS_VACIOS).
   *
   * Existe para que una corrida acotada -una prueba, un drenado puntual-
   * pueda esperar el final sin sondear contadores desde fuera. En la corrida
   * normal nadie lo espera: el lazo no termina.
   */
  private terminar!: () => void;
  readonly terminado = new Promise<void>((r) => {
    this.terminar = r;
  });

  readonly contadores = {
    recibidos: 0,
    borrados: 0,
    fallos_borrado: 0,
    ciclos: 0,
    ciclos_vacios: 0,
    errores: 0,
    bytes: 0,
  };

  /**
   * Lo que el health necesita saber del lazo. `corriendo` en false con el
   * proceso vivo es un consumidor que ya paro —C4_SALIR_TRAS_VACIOS, o un
   * cierre en curso— y no esta consumiendo nada, aunque el contenedor siga en
   * pie: desde fuera las dos situaciones son indistinguibles sin esto.
   */
  estado(): {
    corriendo: boolean;
    vacios_seguidos: number;
    contadores: typeof ConsumidorService.prototype.contadores;
  } {
    return {
      corriendo: this.corriendo,
      vacios_seguidos: this.vaciosSeguidos,
      contadores: { ...this.contadores },
    };
  }

  constructor(
    private readonly config: ConfigService,
    private readonly procesador: ProcesadorService,
    private readonly inbox: InboxRepository,
    private readonly descifrador: DescifradorService,
    private readonly verificador: VerificadorService,
    private readonly dlq: DlqService,
    private readonly metricas: MetricasService,
  ) {
    // Cliente en singleton. Uno por mensaje reabriria el pool de sockets en
    // cada vuelta y medirias el cliente, no la arquitectura.
    this.sqs = new SQSClient({ region: this.config.region });
  }

  onApplicationBootstrap(): void {
    this.corriendo = true;
    this.logger.log(
      `escuchando ${this.config.colaUrl} · region=${this.config.region} ` +
        `lote=${this.config.loteMax} espera=${this.config.esperaSegundos}s ` +
        `borrar=${this.config.borrar}`,
    );
    // ── N lazos, no uno ───────────────────────────────────────────────────
    //
    // Se llaman SIN await, y ahi esta todo el truco: una funcion `async` corre
    // hasta su primer `await` y devuelve el control. La primera arranca, llega
    // a `await ReceiveMessage` y se suspende; entonces arranca la segunda, y
    // asi las N. Al terminar este bucle hay N `while` vivos, cada uno
    // esperando SU propia respuesta de SQS, cada uno con sus variables
    // locales.
    //
    // ⚠ NO es `await Promise.all(...)` por ciclo. Eso seria una BARRERA: los N
    //   arrancarian a la vez pero cada ronda duraria lo que el ciclo mas lento
    //   y el resto esperaria de brazos cruzados. El Promise.all va en el
    //   cierre, una sola vez.
    for (let i = 0; i < this.config.concurrencia; i += 1) {
      this.lazos.push(this.lazoPrincipal());
    }
    this.resumen = setInterval(() => void this.emitirResumen(), this.config.resumenCadaMs);
  }

  /**
   * Fargate da 30 s tras el SIGTERM. Abortamos el ReceiveMessage en vuelo y
   * esperamos a que el ciclo actual termine: salir en medio deja mensajes
   * persistidos y no borrados, que reaparecen y se cuentan dos veces.
   */
  async onApplicationShutdown(senal?: string): Promise<void> {
    if (this.cerrado) return;
    this.cerrado = true;
    this.corriendo = false;
    this.logger.log(`cierre ordenado (${senal ?? 'sin senal'}) · drenando el ciclo en curso`);
    if (this.resumen) clearInterval(this.resumen);
    this.abort.abort();
    // Todos, no el primero: con N lazos, esperar a uno solo deja a los otros
    // N-1 con mensajes persistidos y sin borrar.
    await Promise.all(this.lazos.map((l) => l.catch(() => undefined)));
    this.sqs.destroy();
    await this.emitirResumen();
  }

  private async lazoPrincipal(): Promise<void> {
    let backoffMs = 0;

    while (this.corriendo) {
      const tCiclo = ahora();
      try {
        const respuesta = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: this.config.colaUrl,
            MaxNumberOfMessages: this.config.loteMax,
            WaitTimeSeconds: this.config.esperaSegundos,
            // Sin esto no vuelven MessageGroupId ni MessageDeduplicationId,
            // que son los dos datos con los que C4 comprueba que el sobre por
            // fuera dice lo mismo que por dentro.
            MessageSystemAttributeNames: ['All'],
            // Y sin esto no vuelve `prueba`, el id de corrida que escribio el
            // relay de C3. Es lo unico que permite separar las metricas de dos
            // pruebas seguidas: sin el, las dos caen en el mismo archivo.
            MessageAttributeNames: ['All'],
          }),
          { abortSignal: this.abort.signal },
        );

        backoffMs = 0;
        this.contadores.ciclos += 1;
        const msRecibir = msDesde(tCiclo);

        const mensajes = respuesta.Messages ?? [];
        if (mensajes.length === 0) {
          this.contadores.ciclos_vacios += 1;
          this.vaciosSeguidos += 1;
          // El ciclo vacio se anota SIN duracion: los 20 s que se paso dentro
          // del long polling son cola vacia, no coste de C4, y meterlos en
          // `receive` haria que el p99 empeorase justo cuando C4 va sobrado.
          //
          // Y solo si YA hubo una corrida: antes del primer mensaje no hay
          // ninguna a la que atribuir un sondeo en vacio, e inventarle una
          // dejaria en disco el log de una prueba que no existio.
          if (this.pruebaEnCurso) this.metricas.ciclo(this.pruebaEnCurso, true, null);
          if (
            this.config.salirTrasVaciosSeguidos > 0 &&
            this.vaciosSeguidos >= this.config.salirTrasVaciosSeguidos
          ) {
            this.logger.log(`${this.vaciosSeguidos} ciclos vacios seguidos · fin de la corrida`);
            this.corriendo = false;
          }
          continue;
        }
        this.vaciosSeguidos = 0;

        await this.procesarLote(mensajes, msRecibir);
      } catch (error) {
        if (!this.corriendo) break;
        this.contadores.errores += 1;
        // Un ReceiveMessage que revienta NO es un lote fallido: no llego a
        // haber lote. Se cuenta en `sqs.failed`, que es el contador que
        // distingue "la cola no contesta" de "los mensajes no se procesan".
        if (this.pruebaEnCurso) this.metricas.cicloFallido(this.pruebaEnCurso);
        // Sin backoff, una cola inexistente o un permiso faltante produce un
        // lazo caliente que quema la cuota de API de SQS -300/s por accion- y
        // llena CloudWatch con el mismo error miles de veces por minuto.
        backoffMs = Math.min(backoffMs === 0 ? 500 : backoffMs * 2, 10_000);
        this.logger.error(`ReceiveMessage fallo, reintento en ${backoffMs}ms: ${texto(error)}`);
        await dormir(backoffMs, this.abort.signal);
      }
    }

    this.logger.log('lazo detenido');
    this.terminar();
  }

  /**
   * @param msRecibir cuanto tardo el `ReceiveMessage` que trajo este lote.
   *                  Llega desde el lazo porque ahi es donde se cronometra, y
   *                  se anota aqui —una vez por corrida presente— porque hasta
   *                  no leer los atributos no se sabe de que corrida es.
   */
  private async procesarLote(mensajes: Message[], msRecibir: number): Promise<void> {
    // e7 · "C4 recibe el mensaje". Uno por mensaje pero el mismo instante
    // para todo el lote: llegaron juntos en la misma respuesta, y estamparlos
    // segun el orden en que se procesan le sumaria a e7 el tiempo de procesar
    // los anteriores — que ya se esta midiendo en e7→e10.
    const e7 = new Date();
    // El gemelo monotono de e7. Los tramos se miden con `hrtime` y no restando
    // dos ISO: verificar Ed25519 sobre 3 KB es sub-milisegundo y la resta de
    // dos marcas con resolucion de milisegundo lo daria en 0.
    const t7 = ahora();
    this.contadores.recibidos += mensajes.length;

    // ── Repartir el lote por corrida ──
    //
    // En una corrida normal todas las filas de un lote son de la misma prueba
    // y este mapa tiene una entrada. Puede tener dos cuando dos corridas se
    // solapan en la cola, y entonces cada una lleva su archivo: sumarlas en
    // una haria que el informe de la segunda arrastrase el trafico de la
    // primera.
    const porPrueba = new Map<string, { n: number; bytes: number }>();
    const pruebaDe = new Map<Message, string>();
    for (const m of mensajes) {
      const prueba = normalizar(m.MessageAttributes?.prueba?.StringValue);
      const bytes = Buffer.byteLength(m.Body ?? '', 'utf8');
      this.contadores.bytes += bytes;
      pruebaDe.set(m, prueba);
      const acc = porPrueba.get(prueba);
      if (acc) { acc.n += 1; acc.bytes += bytes; }
      else porPrueba.set(prueba, { n: 1, bytes });
    }
    // La ultima corrida vista. Es a la que se le imputan los ciclos vacios y
    // los fallos de ReceiveMessage, que llegan sin ningun mensaje del que
    // sacar el id.
    this.pruebaEnCurso = [...porPrueba.keys()][0] ?? this.pruebaEnCurso;

    // ⚠ El ciclo y el lote se anotan UNA VEZ POR CORRIDA presente, no una vez
    // en total. Con dos corridas solapadas eso hace que la misma llamada
    // cuente en las dos — igual que el relay de C3 reparte su `sqs` entre las
    // pruebas del lote. Es la unica opcion honesta: la llamada trajo trabajo
    // de las dos y no se puede partir por la mitad.
    for (const [prueba, c] of porPrueba) {
      this.metricas.ciclo(prueba, false, msRecibir);
      this.metricas.lote(prueba, c.n, c.bytes);
      this.metricas.abre(prueba, 'batch');
    }

    const aBorrar: Message[] = [];
    const e10s: Array<{ payloadHash: string; e10: Date }> = [];

    try {
      // ── EN PARALELO POR GRUPO, EN SERIE DENTRO DEL GRUPO ──
      //
      // FIFO garantiza el orden dentro de un `MessageGroupId`, y ese orden es
      // lo que hace posible la deteccion de huecos de P4: si los eventos de un
      // expediente se procesaran a la vez, el `sequence` 3 podria persistirse
      // antes que el 2 y un hueco transitorio se leeria como definitivo.
      //
      // Entre grupos distintos NO hay orden que preservar: son expedientes
      // distintos, y SQS tampoco promete nada entre ellos.
      //
      // ⚠ ESTO ERA UN `for` EN SERIE SOBRE TODO EL LOTE. Era correcto, pero
      //   pagaba el viaje a Postgres de cada mensaje uno detras de otro: con
      //   `persistir` en ~8 ms medidos, diez mensajes eran ~80 ms y el techo se
      //   quedaba en ~80 msg/s por task. Agrupando, un lote de diez
      //   expedientes distintos tarda lo que el mas lento, no lo que la suma.
      //
      //   La razon que justificaba la serie sigue siendo cierta — solo que se
      //   aplica al GRUPO, no al lote.
      //
      // ⚠ `MessageGroupId` llega porque el ReceiveMessage pide
      //   `MessageSystemAttributeNames: ['All']`. Si eso cambiara, todos los
      //   mensajes caerian en la misma clave y esto volveria a ser secuencial:
      //   mas lento, nunca incorrecto. Es la degradacion que se quiere.
      //
      // ⚠ CONCURRENCIA CONTRA EL POOL. Cada grupo abre su propia transaccion,
      //   asi que un lote de 10 grupos pide 10 conexiones a la vez y el pool
      //   son 10 por defecto (`C4_BD_POOL`). Justo alcanza. Al subir
      //   `SQS_BATCH_SIZE` o al meter varios lazos de recepcion hay que subir
      //   el pool con ellos, o las transacciones se serializan esperando
      //   conexion y el paralelismo desaparece sin un solo error.
      const porGrupo = new Map<string, Message[]>();
      for (const mensaje of mensajes) {
        const grupo = mensaje.Attributes?.MessageGroupId ?? '';
        const lista = porGrupo.get(grupo);
        if (lista) lista.push(mensaje);
        else porGrupo.set(grupo, [mensaje]);
      }

      const porLote = await Promise.all(
        [...porGrupo.values()].map(async (delGrupo) => {
          const parciales: Array<{ mensaje: Message; r: Resultado }> = [];
          for (const mensaje of delGrupo) {
            parciales.push({
              mensaje,
              r: await this.procesador.procesar(
                mensaje, e7, t7, pruebaDe.get(mensaje)!, this.config.loteTransaccion,
              ),
            });
          }
          return parciales;
        }),
      );

      const resultados = porLote.flat();

      // ── El COMMIT del lote (C4_LOTE_TRANSACCION) ──
      //
      // Los que quedaron en `diferir` estan descifrados y verificados, pero sin
      // asiento. Van todos en una transaccion: ~7 viajes a RDS y UN fsync en
      // vez de ~8 viajes y un fsync POR MENSAJE.
      const diferidos = resultados.filter((x) => x.r.accion === 'diferir');
      if (diferidos.length > 0) {
        const tLote = ahora();
        for (const prueba of porPrueba.keys()) this.metricas.abre(prueba, 'inbox');
        try {
          const nuevos = await this.inbox.persistirLote(
            diferidos.map((x) => x.r.diferido!),
          );
          // e10 del lote: un COMMIT, un instante. No es una aproximacion —los
          // N eventos SI se persistieron a la vez— pero el tramo e9→e10 pasa a
          // medir el lote y no el evento. Es el precio, y esta documentado en
          // `persistirLote`.
          const e10 = new Date();
          const ms = msDesde(tLote);
          for (const prueba of porPrueba.keys()) this.metricas.cierra(prueba, 'inbox', ms);

          for (const { mensaje, r } of diferidos) {
            const hash = r.payloadHash!;
            const prueba = pruebaDe.get(mensaje)!;
            const bytes = r.relojes?.canonicoLen ?? 0;
            if (nuevos.get(hash)) {
              this.procesador.contadores.persistidos += 1;
              this.metricas.mensaje(prueba, 'persistido', hash, bytes);
              e10s.push({ payloadHash: hash, e10 });
            } else {
              this.procesador.contadores.duplicados += 1;
              this.metricas.mensaje(prueba, 'duplicado', hash, bytes);
            }
            if (r.relojes) this.metricas.cierra(prueba, 'message', msDesde(r.relojes.t7b));
            aBorrar.push(mensaje);
          }
        } catch (e) {
          // ⚠ AQUI SE RECUPERA EL AISLAMIENTO DEL MENSAJE ENVENENADO.
          //
          // Una fila mala hace rollback de TODAS. Sin este reintento, diez
          // mensajes buenos volverian a la cola por culpa de uno y marcharian
          // juntos hacia la DLQ. Se reintenta de a uno: el veneno se queda
          // solo y los demas pasan.
          this.logger.warn(
            `el lote de ${diferidos.length} no commiteo (${texto(e)}); reintento de a uno`,
          );
          for (const { mensaje, r } of diferidos) {
            const prueba = pruebaDe.get(mensaje)!;
            this.metricas.abre(prueba, 'inbox');
            try {
              const uno = await this.inbox.persistir(r.diferido!);
              this.metricas.cierra(prueba, 'inbox', 0);
              const bytes = r.relojes?.canonicoLen ?? 0;
              if (uno.nuevo) {
                this.procesador.contadores.persistidos += 1;
                this.metricas.mensaje(prueba, 'persistido', r.payloadHash!, bytes);
                e10s.push({ payloadHash: r.payloadHash!, e10: uno.e10 });
              } else {
                this.procesador.contadores.duplicados += 1;
                this.metricas.mensaje(prueba, 'duplicado', r.payloadHash!, bytes);
              }
              aBorrar.push(mensaje);
            } catch (e2) {
              // Este si es el envenenado: no se borra, que lo reentregue SQS y
              // el redrive_policy lo mande a la DLQ a las 5 recepciones.
              this.procesador.contadores.reintentar += 1;
              this.metricas.mensaje(prueba, 'reintentar', r.payloadHash!);
              this.logger.error(
                `no se pudo persistir ${r.payloadHash!.slice(0, 12)}: ${texto(e2)}`,
              );
            }
          }
        }
      }

      for (const { mensaje, r } of resultados) {
        if (r.accion === 'borrar') aBorrar.push(mensaje);
        if (r.e10 && r.payloadHash) e10s.push({ payloadHash: r.payloadHash, e10: r.e10 });
      }

      // e10 del lote entero en una sentencia. El reloj ya paro para cada
      // evento -e10 se tomo justo despues de SU commit-, asi que agrupar la
      // escritura no mueve ningun numero.
      const tStamp = ahora();
      for (const prueba of porPrueba.keys()) this.metricas.abre(prueba, 'stamp');
      try {
        await this.inbox.estamparE10(e10s);
        const ms = msDesde(tStamp);
        for (const prueba of porPrueba.keys()) this.metricas.cierra(prueba, 'stamp', ms);
      } catch (e) {
        // No es fatal: la fila esta, el asiento esta, lo unico que falta es la
        // marca. Se avisa porque deja un agujero en P1, no en P4. El `stamp`
        // se queda con `init` y sin `completed`, que es como se ve en el log
        // que el UPDATE no llego a cerrar.
        this.logger.warn(`no se pudo estampar e10 de ${e10s.length} eventos: ${texto(e)}`);
      }

      if (this.config.borrar) await this.borrarLote(aBorrar, porPrueba.keys());

      const ms = msDesde(t7);
      for (const prueba of porPrueba.keys()) {
        this.metricas.loteCompletado(prueba, ms);
        this.metricas.cierra(prueba, 'batch', ms);
      }
    } catch (e) {
      // El lote revento entero. Se cuenta como fallido y su latencia NO entra
      // en los percentiles: el tiempo hasta un fallo no es tiempo de servicio,
      // y meterlo moveria el p99 por una causa que no es de rendimiento.
      for (const prueba of porPrueba.keys()) this.metricas.loteFallido(prueba);
      throw e;
    }
  }

  /**
   * Borrado por lote, DESPUES de persistir. El orden importa: borrar antes de
   * procesar convierte la entrega en como-mucho-una-vez y una perdida dejaria
   * de verse en P4.
   */
  private async borrarLote(mensajes: Message[], pruebas: Iterable<string>): Promise<void> {
    const entradas = mensajes
      .filter((m) => m.ReceiptHandle !== undefined)
      .map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle as string }));
    if (entradas.length === 0) return;

    const enJuego = [...pruebas];
    const tBorrar = ahora();
    for (const prueba of enJuego) this.metricas.abre(prueba, 'delete');

    try {
      const respuesta = await this.sqs.send(
        new DeleteMessageBatchCommand({ QueueUrl: this.config.colaUrl, Entries: entradas }),
        // Sin abortSignal a proposito: si ya persistimos, queremos que el
        // borrado alcance a completarse durante el cierre.
      );
      const ok = respuesta.Successful?.length ?? 0;
      this.contadores.borrados += ok;
      const fallidas = respuesta.Failed ?? [];
      const ms = msDesde(tBorrar);
      for (const prueba of enJuego) {
        this.metricas.cierra(prueba, 'delete', ms);
        this.metricas.borrado(prueba, ok, fallidas.length);
      }
      if (fallidas.length > 0) {
        this.contadores.fallos_borrado += fallidas.length;
        this.logger.warn(
          `no se pudieron borrar ${fallidas.length} mensajes: ` +
            fallidas.map((f) => `${f.Id}:${f.Code}`).join(', '),
        );
      }
    } catch (error) {
      this.contadores.fallos_borrado += entradas.length;
      // La duracion se anota TAMBIEN cuando la llamada falla: un timeout de
      // tres segundos es informacion, y dejarlo fuera haria que el p99 de
      // `delete` mejorase justo cuando la cola se cae.
      const ms = msDesde(tBorrar);
      for (const prueba of enJuego) {
        this.metricas.cierra(prueba, 'delete', ms);
        this.metricas.borrado(prueba, 0, entradas.length);
      }
      // No es fatal: el mensaje reaparece y el inbox lo absorbe como
      // duplicado. Para eso existe la idempotencia.
      this.logger.warn(`DeleteMessageBatch fallo: ${texto(error)}`);
    }
  }

  private async emitirResumen(): Promise<void> {
    const c = this.contadores;
    const p = this.procesador.contadores;
    const d = this.descifrador.contadores;
    const v = this.verificador.contadores;

    this.logger.log(
      `resumen · recibidos=${c.recibidos} persistidos=${p.persistidos} ` +
        `duplicados=${p.duplicados} descartados=${p.descartados} ` +
        `reintentar=${p.reintentar} borrados=${c.borrados} ` +
        `| kms: decrypt=${d.decrypt} (cache ${d.cache_hit}) pubkey=${v.get_public_key} ` +
        `| ciclos=${c.ciclos} vacios=${c.ciclos_vacios} errores=${c.errores} bytes=${c.bytes}`,
    );

    // La DLQ se MIRA, no se consume: leerla y borrarla destruiria la
    // evidencia para la que existe.
    const prof = await this.dlq.profundidad();
    if (prof !== null && prof > 0) {
      this.logger.warn(`⚠ la DLQ tiene ${prof} mensajes`);
    }
  }
}

function dormir(ms: number, senal: AbortSignal): Promise<void> {
  return new Promise((resolver) => {
    if (senal.aborted) return resolver();
    const temporizador = setTimeout(fin, ms);
    function fin(): void {
      clearTimeout(temporizador);
      senal.removeEventListener('abort', fin);
      resolver();
    }
    senal.addEventListener('abort', fin, { once: true });
  });
}

function texto(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
