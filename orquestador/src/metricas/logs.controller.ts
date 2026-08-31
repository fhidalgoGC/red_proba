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
import { basename, dirname, join, resolve } from 'node:path';
import { RegistroService } from './registro.service';

/**
 * `GET /logs/:id` — bajarse el informe de una corrida sin entrar al contenedor.
 *
 * En AWS los logs viven en el disco efimero de la task: cuando la task muere
 * —y muere en cuanto se apaga el despliegue (T-07)— el JSON se va con ella.
 * `docker cp` no existe ahi y abrir un exec a Fargate para leer un archivo es
 * mas trabajo que servirlo.
 *
 * ⚠ SIRVE EL ARCHIVO, NO LA MEMORIA. Durante una corrida viva el archivo se
 * reescribe cada cierto numero de segundos (ver `PERIODO_*` en
 * `registro.service.ts`), asi que puede ir por detras de lo que esta pasando.
 * Para el dato al segundo estan `/status` y `/status/serie`, que se reconstruyen
 * en cada llamada. Este endpoint es para el informe cerrado.
 *
 * El id es el de la prueba: el mismo que devuelve `POST /batch` y que aparece
 * en `GET /status` como `config.prueba`. Como el nombre del archivo es
 * `<id>.json`, pasando `<id>__manifiesto` sale tambien el manifiesto de
 * expedientes (O-08), que es el otro JSON que escribe el registro.
 */
@ApiTags('observabilidad')
@Controller('logs')
export class LogsController {
  constructor(private readonly registro: RegistroService) {}

  @ApiOperation({
    summary: 'Descarga `orquestador/logs/<id>.json`',
    description:
      'El informe de la corrida tal como esta en disco, como adjunto.\n\n' +
      '`id` es el id de prueba —lo devuelve `POST /batch` y sale en `GET /status` como ' +
      '`config.prueba`—. Con `<id>__manifiesto` baja el manifiesto de expedientes ' +
      '(O-08), que es la mitad "ofrecido" de la conciliacion de P4.\n\n' +
      '⚠ Es el ARCHIVO, no la memoria: en una corrida viva puede ir unos segundos por ' +
      'detras. El dato al instante esta en `/status` y `/status/serie`.',
  })
  @ApiParam({ name: 'id', example: 'final', description: 'Id de la prueba (`config.prueba`).' })
  @ApiResponse({
    status: 200,
    description: 'El JSON del informe.',
    content: { 'application/json': { schema: { type: 'string', format: 'binary' } } },
  })
  @ApiResponse({ status: 400, description: 'Id con caracteres que no puede tener un nombre de archivo.' })
  @ApiResponse({ status: 404, description: 'No hay informe con ese id. El cuerpo lista los que si hay.' })
  @Get(':id')
  descargar(@Param('id') id: string): StreamableFile {
    const prueba = exigirId(id);
    return adjuntar(
      this.registro.carpeta,
      [basename(this.registro.rutaDe(prueba))],
      prueba,
      'el informe se escribe cuando la corrida arranca y se cierra al terminar: ' +
        'si la corrida no ha empezado todavia, el archivo no existe.',
    );
  }
}

// ---------------------------------------------------------------------------

/**
 * Solo lo que puede llevar un nombre de archivo. El id llega de fuera y se
 * concatena a una ruta: sin esto, un `../..` convertiria este endpoint en un
 * lector de todo el contenedor.
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
 * manifiesto de una corrida larga pasa de los megas y una descarga sin tamaño
 * no se distingue de una colgada.
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
    mensaje: `no hay log de '${id}'`,
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
