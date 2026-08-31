import { Body, Controller, Headers, HttpCode, Logger, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ApiBody, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  EJEMPLO_DOCUMENTO,
  EJEMPLO_DOCUMENTO_INVALIDO,
  LoteEntranteDto,
  RespuestaLoteDto,
} from './eventos.dto';
import { PipelineService } from './pipeline/pipeline.service';
import { RETARDO, dormir } from './retardo';
import { MetricasService, ahora, msDesde, normalizar } from './metricas/metricas.service';

/**
 * C-01, primera mitad: el endpoint que recibe.
 *
 * ⚠ C3 PARCIAL. Ya canoniza (C-02), firma (C-03) y cifra (C-04); todavia NO
 * escribe outbox (C-05) ni publica a SQS (C-06), asi que el sobre se
 * construye, se mide y se tira. HOY NADA LLEGA A C4.
 *
 * Lo que YA define, y por eso vale la pena que exista ahora, es el CONTRATO
 * entre los dos tracks. Es el UNICO camino de entrada: la generacion se mudo
 * al orquestador y `POST /events/generar` ya no existe.
 *
 *   POST /events
 *   x-prueba-id: xxt                      <- identificador de la corrida
 *   { "lote_id": uuid, "tenant_id": string, "documentos": [ {...}, ... ] }
 *   → 202 { recibidos, aceptados, descartados[], lote_id, prueba }
 *
 * La respuesta es 202 y no 200 a proposito: C-01 manda encolar el trabajo y
 * contestar de inmediato con un id de lote. Con lotes grandes, canonizar y
 * firmar dentro del handler agota el timeout HTTP y el techo que medirias
 * seria el del cliente, no el de la arquitectura. Cuando C3 encole de verdad,
 * el codigo seguira siendo 202.
 *
 * La forma exacta del cuerpo, las cabeceras y las respuestas esta documentada
 * en los decoradores de abajo y en `eventos.dto.ts`, y sale servida en
 * `/docs`. Los DTO documentan, no validan: la validacion de verdad es la del
 * mapper, que descarta documento a documento con motivo y campo en vez de
 * tumbar el lote entero con un 400.
 */

/** Lo que de verdad llega. El DTO documenta; esto es lo que se lee. */
type LoteEntrante = Partial<LoteEntranteDto> & { documentos?: unknown[] };

@ApiTags('eventos')
@Controller()
export class EventosController {
  private readonly logger = new Logger(EventosController.name);

  constructor(
    private readonly metricas: MetricasService,
    private readonly pipeline: PipelineService,
  ) {}

  @Post('events')
  @HttpCode(202)
  @ApiOperation({
    summary: 'Recibe un lote de documentos, los valida, firma y cifra',
    description:
      'El UNICO camino de entrada a C3. Valida contra el contrato de atributos, ' +
      'sustituye `party_id` por el HMAC-SHA256 real, canoniza (JCS), firma (Ed25519) y ' +
      'cifra (AES-256-GCM).\n\n' +
      '**Un lote es un REQUEST**, no un segundo ni nada dentro del payload: los N ' +
      'documentos que el orquestador empaqueto en este POST. Cada documento se ' +
      'resuelve solo, asi que el 202 trae `aceptados` y `descartados` por separado.\n\n' +
      '### 202 y no 200, a proposito\n' +
      'C-01 manda encolar y contestar de inmediato. Con lotes grandes, canonizar y ' +
      'firmar dentro del handler agota el timeout HTTP y el techo que medirias seria ' +
      'el del cliente, no el de la arquitectura. Cuando C3 encole de verdad, el ' +
      'codigo seguira siendo 202.\n\n' +
      '⚠ **Todavia NO escribe outbox (C-05) ni publica a SQS (C-06).** El sobre se ' +
      'construye, se mide y se tira: HOY NADA LLEGA A C4, por mucho que la respuesta ' +
      'diga `aceptados`. Confirmalo en `GET /health` → `publica_a_sqs`.',
  })
  @ApiHeader({
    name: 'x-prueba-id',
    required: false,
    example: 'abc16',
    description:
      'Identificador de la corrida, el mismo que se le paso al orquestador en ' +
      '`POST /batch`. Da nombre a `c3/logs/<prueba>__<tenant>.json`. Sin el, dos ' +
      'pruebas distintas caen en el mismo archivo y la conciliacion de P4 mezcla ' +
      'corridas. Un id con forma rara acaba en `sin-id` en vez de en un nombre de archivo.',
  })
  @ApiHeader({
    name: 'x-lote-id',
    required: false,
    example: '7f3a1c88-2d4e-4b91-a0f6-5e8c1b7d9a20',
    description: 'Respaldo del `lote_id` del cuerpo. Solo se usa si el cuerpo no lo trae.',
  })
  @ApiBody({
    type: LoteEntranteDto,
    examples: {
      unDocumento: {
        summary: 'Un documento valido — 3.072 bytes canonicos',
        value: {
          lote_id: '7f3a1c88-2d4e-4b91-a0f6-5e8c1b7d9a20',
          tenant_id: 'tenant-01',
          documentos: [EJEMPLO_DOCUMENTO],
        },
      },
      loteMixto: {
        summary: 'Uno bueno y uno malo — los malos no tumban a los buenos',
        description:
          'El segundo trae `totals.total` como number en vez de string. Devuelve 202 ' +
          'con aceptados=1 y un descarte por `formato_invalido` en `totals.total`. ' +
          'Es la regla 1 de CLAUDE.md, y es la unica que rompe la PoC en silencio si ' +
          'nadie la atrapa aqui.',
        value: {
          lote_id: '7f3a1c88-2d4e-4b91-a0f6-5e8c1b7d9a21',
          tenant_id: 'tenant-01',
          documentos: [EJEMPLO_DOCUMENTO, EJEMPLO_DOCUMENTO_INVALIDO],
        },
      },
      soloDocumentos: {
        summary: 'Sin envoltorio — el lote_id viaja en la cabecera',
        value: { documentos: [EJEMPLO_DOCUMENTO] },
      },
    },
  })
  @ApiResponse({
    status: 202,
    type: RespuestaLoteDto,
    description:
      'Aceptado. ⚠ El 202 dice que C3 lo proceso, NO que llego a C4 — eso solo pasa ' +
      'cuando C-05 y C-06 existan. Un lote entero descartado tambien devuelve 202, ' +
      'con `aceptados: 0`: el error es del documento, no del request.',
  })
  @ApiResponse({
    status: 413,
    description:
      'El cuerpo paso de 16 MB. Es config del arnes, no del sistema: son ~5.000 ' +
      'documentos en un POST. Baja `perRequest` en el orquestador.',
  })
  async recibir(
    @Body() lote: LoteEntrante,
    @Req() req: Request,
    @Headers('x-prueba-id') prueba?: string,
    @Headers('x-lote-id') loteId?: string,
  ) {
    // El primer instante que este proceso puede observar de la peticion. El
    // cuerpo ya viene parseado por express, asi que el parseo NO entra: es
    // deuda conocida de la medicion, no un olvido. Ver C-09 en 07-medicion.
    const t0 = ahora();
    const docs = Array.isArray(lote?.documentos) ? lote.documentos : [];

    // Se normaliza UNA VEZ, aqui en el borde: la misma clave viaja al pipeline,
    // a la columna `prueba` del outbox y al nombre del archivo. Si cada capa
    // normalizara por su cuenta, un id con forma rara acabaria en `sin-id` en
    // el log y en el valor crudo en la base.
    const corrida = normalizar(prueba);

    // El peso se toma del cuerpo CRUDO, no de re-serializar los documentos:
    // volver a pasarlos por JSON.stringify daria un numero parecido pero no
    // el que viajo por el cable, y el cable es lo que se esta midiendo.
    const bytes = pesoDeLosDocumentos(req, docs);

    // Se anota ANTES de procesar: la llegada ocurrio ya. Anotarla despues
    // moveria el evento al segundo equivocado y falsearia la conciliacion —
    // y el desfase entre `init` y `completed` es justo lo que se mide.
    this.metricas.entrada(corrida, docs, bytes);

    let procesados;
    let descartados;
    try {
      ({ procesados, descartados } = await this.pipeline.procesar(docs, corrida));

      if (RETARDO) {
        // El retardo artificial sale como un paso mas y no escondido dentro
        // de la latencia: sin el, una perilla de 300 ms aparece como un hueco
        // entre `pipeline` y la latencia que alguien lee como coste del
        // sistema. Es lo que cierra la aritmetica de la fila.
        const tDelay = ahora();
        this.metricas.abre(corrida, 'delay');
        await dormir(RETARDO.min + Math.floor(Math.random() * (RETARDO.max - RETARDO.min + 1)));
        this.metricas.cierra(corrida, 'delay', msDesde(tDelay));
      }
    } catch (e) {
      // Sin 202 no hay `completed`. Contarlo como completado con su latencia
      // meteria el tiempo hasta un fallo dentro del p99 de servicio, que es
      // otra cosa: un fallo rapido bajaria el percentil y un timeout lo
      // dispararia, las dos veces sin que el rendimiento haya cambiado.
      //
      // No hace falta arrastrar nada: cada tramo ya anoto su `init` al
      // empezar. Un lote roto en la firma deja `sign.init` sin su `completed`
      // y señala el tramo sin leer un solo log de texto.
      this.metricas.fallida(corrida, msDesde(t0));
      throw e;
    }

    // La marca de completado se toma AQUI, no cuando el socket se vacia: es lo
    // ultimo que este handler puede observar. La serializacion de la respuesta
    // y el viaje de vuelta quedan fuera — el orquestador los tiene dentro de
    // SU latencia, y la diferencia entre los dos numeros es exactamente la red.
    this.metricas.completada(corrida, msDesde(t0), procesados.length, descartados.length);

    // `aceptados` y `descartados` van SEPARADOS del `recibidos`. El
    // orquestador cuenta lo que ofrecio; si C3 contestara solo "recibidos" y
    // se comiera los descartes en su log, la conciliacion de P4 daria un
    // falso negativo sin un solo error a la vista.
    return {
      recibidos: docs.length,
      aceptados: procesados.length,
      descartados: descartados.map((d) => ({
        event_id: d.eventId,
        indice: d.indice,
        motivo: d.motivo,
        campo: d.campo,
      })),
      lote_id: lote?.lote_id ?? loteId ?? null,
      prueba: prueba ?? null,
    };
  }
}

/**
 * Bytes del array `documentos` tal como llegaron.
 *
 * Se prefiere el cuerpo crudo que guarda el middleware de express; si no
 * estuviera, se re-serializa como aproximacion y no se miente sobre ello.
 */
function pesoDeLosDocumentos(req: Request, docs: unknown[]): number {
  const crudo = (req as Request & { rawBody?: Buffer }).rawBody;
  if (crudo) {
    // El envoltorio (lote_id, tenant_id, las llaves) no es payload: se
    // descuenta para que el numero sea comparable con los bytes canonicos
    // que contabiliza el orquestador.
    const envoltorio = Buffer.byteLength(
      JSON.stringify({ lote_id: (req.body as LoteEntrante)?.lote_id, tenant_id: (req.body as LoteEntrante)?.tenant_id, documentos: [] }),
      'utf8',
    );
    const separadores = Math.max(0, docs.length - 1);
    return Math.max(0, crudo.length - envoltorio - separadores);
  }
  return docs.reduce<number>((a, d) => a + Buffer.byteLength(JSON.stringify(d), 'utf8'), 0);
}
