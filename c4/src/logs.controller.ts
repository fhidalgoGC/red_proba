import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  StreamableFile,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { createReadStream, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ConfigService } from './config/config.service';

/**
 * `GET /logs/:id` — bajarse los archivos de C4 sin entrar al contenedor.
 *
 * ────────────────────────────────────────────────────────────────────────
 * HAY DOS ARCHIVOS POR CORRIDA Y NO SON LO MISMO
 *
 *   <id>__c4.json      G-11 · el reloj del consumidor, SEGUNDO A SEGUNDO. Lo
 *                      escribe el propio proceso desde memoria. Contesta
 *                      P1/P2/P3 desde el lado de C4.
 *   <id>__inbox.json   G-08 · el volcado del LEDGER. Lo escribe el CLI
 *                      `npm run informe` leyendo Postgres. Es la mitad
 *                      "llegado" de P4.
 *
 * `/logs/<id>` da el primero, que es el analogo del log de C3 y del
 * orquestador. `/logs/<id>__inbox` da el segundo — el mismo truco de sufijo
 * con el que el orquestador sirve su `<id>__manifiesto`.
 *
 * Si no hay log por segundo pero si volcado del ledger, `/logs/<id>` sirve el
 * volcado en vez de un 404: es lo que hacia antes de G-11 y es lo que espera
 * quien ya tiene el comando en un script.
 *
 * ⚠ NINGUNO DE LOS DOS CONSULTA LA BASE. C4 sigue sin tener una consulta al
 * ledger por HTTP: su unica ENTRADA es la cola (D-03). Este endpoint sirve
 * archivos que ya estan en disco — si nadie corrio el CLI, `__inbox` no
 * existe aunque el ledger tenga los datos.
 * ────────────────────────────────────────────────────────────────────────
 *
 * Por que existe: en AWS los archivos viven en el disco efimero de la task y
 * la task muere en cuanto se apaga el despliegue (T-07). Sin esto, hay que
 * sacarlos con un exec a Fargate.
 *
 * El puerto sigue escuchando en 127.0.0.1 salvo que `C4_HEALTH_HOST` diga otra
 * cosa, asi que esto NO queda publicado a la VPC del operador: se alcanza desde
 * dentro de la task, igual que el health.
 */
@ApiTags('observabilidad')
@Controller('logs')
export class LogsController {
  constructor(private readonly config: ConfigService) {}

  @ApiOperation({
    summary: 'Descarga `c4/logs/<id>__c4.json` (y con `<id>__inbox`, el volcado del ledger)',
    description:
      'Dos archivos, un endpoint:\n\n' +
      '| Ruta | Archivo | Que es |\n' +
      '|---|---|---|\n' +
      '| `/logs/<id>` | `<id>__c4.json` | **G-11** · el reloj del consumidor segundo a ' +
      'segundo: lotes, mensajes y los doce tramos con su `init`/`completed`. Lo escribe ' +
      'el proceso desde memoria. Contesta P1/P2/P3. |\n' +
      '| `/logs/<id>__inbox` | `<id>__inbox.json` | **G-08** · el volcado del ledger que ' +
      'dejo `npm run informe -- --prueba <id>`. Es la mitad "llegado" de P4; la otra la ' +
      'escribe el orquestador (`<id>__manifiesto.json`) y las cruza `npm run conciliar`. |\n\n' +
      '`id` es el id de corrida: el que genero el orquestador y que llego hasta aqui en ' +
      'el `MessageAttribute` `prueba` del mensaje. Los mensajes que llegaron sin ese ' +
      'atributo caen en `sin-id`.\n\n' +
      '⚠ **Sirve archivos, no consulta la base.** El de G-08 no existe hasta que se ' +
      'corre el CLI; el de G-11 puede ir hasta un minuto por detras en una corrida viva ' +
      '—el acumulado al instante esta en `/status`—. C4 no expone el ledger por HTTP a ' +
      'proposito (D-03).',
  })
  @ApiParam({ name: 'id', example: 'final', description: 'Id de corrida. Con sufijo `__inbox`, el volcado del ledger.' })
  @ApiResponse({
    status: 200,
    description: 'El JSON del volcado.',
    content: { 'application/json': { schema: { type: 'string', format: 'binary' } } },
  })
  @ApiResponse({ status: 400, description: 'Id con caracteres que no puede tener un nombre de archivo.' })
  @ApiResponse({ status: 404, description: 'No hay volcado con ese id. El cuerpo lista los que si hay.' })
  @Get(':id')
  descargar(@Param('id') id: string): StreamableFile {
    const prueba = exigirId(id);
    return adjuntar(
      this.config.dirLogs,
      // EL ORDEN ES EL CONTRATO, y por eso esta aqui y no en dos rutas:
      //
      //   <id>__c4.json     lo primero, porque `/logs/<id>` significa "el log"
      //                     en los tres contenedores y en C4 el log es este.
      //   <id>__inbox.json  para `/logs/<id>__inbox` —el primer candidato seria
      //                     `<id>__inbox__c4.json`, que no existe— y tambien
      //                     como respaldo de `/logs/<id>` cuando no hay log por
      //                     segundo: es lo que este endpoint servia antes de
      //                     G-11 y lo que espera quien ya lo tiene en un script.
      //   <id>.json         para quien pega el nombre del archivo completo en
      //                     vez del id. Es el error natural cuando ya viste la
      //                     carpeta, y un 404 ahi solo hace perder el viaje.
      [`${prueba}__c4.json`, `${prueba}__inbox.json`, `${prueba}.json`],
      prueba,
      'el log por segundo lo escribe el consumidor mientras llega trafico, y el volcado ' +
        'del ledger hay que pedirlo: `npm run informe -- --prueba <id>`.',
    );
  }
}

// ---------------------------------------------------------------------------

/**
 * Solo lo que puede llevar un nombre de archivo. El id llega de fuera y se
 * concatena a una ruta: sin esto, un `../..` convertiria este endpoint en un
 * lector de todo el contenedor — y este contenedor es el del operador neutro.
 */
const ID_VALIDO = /^[A-Za-z0-9._-]{1,120}$/;

function exigirId(id: string): string {
  if (!ID_VALIDO.test(id)) {
    throw new BadRequestException(
      `id invalido: solo letras, digitos, '.', '_' y '-', hasta 120 caracteres`,
    );
  }
  return id;
}

/**
 * El primer candidato que exista, servido como adjunto.
 *
 * Se manda con `Content-Length` para que el cliente sepa cuanto falta: el
 * volcado de una corrida larga pasa de los megas y una descarga sin tamaño no
 * se distingue de una colgada.
 */
function adjuntar(dir: string, candidatos: string[], id: string, ayuda: string): StreamableFile {
  const base = resolve(dir);

  for (const nombre of candidatos) {
    const ruta = join(base, nombre);

    // `resolve` normaliza. Si el id trajera un salto que el regex no vio, la
    // ruta se saldria de la carpeta y aqui se nota: el que sirve archivos no
    // confia en el que valida.
    if (dirname(resolve(ruta)) !== base) throw new BadRequestException('id invalido');

    let tamano: number;
    try {
      const st = statSync(ruta);
      if (!st.isFile()) continue;
      tamano = st.size;
    } catch {
      continue;
    }

    return new StreamableFile(createReadStream(ruta), {
      type: 'application/json',
      disposition: `attachment; filename="${nombre}"`,
      length: tamano,
    });
  }

  throw new NotFoundException({
    mensaje: `no hay volcado de '${id}'`,
    carpeta: base,
    buscado: candidatos,
    disponibles: disponibles(base),
    ayuda,
  });
}

/** Los ids que si estan. Un 404 pelado obliga a adivinar el id. */
function disponibles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .slice(0, 50);
  } catch {
    return [];
  }
}
