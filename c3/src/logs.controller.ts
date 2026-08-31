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
import { RegistroService, sanear } from './metricas/registro.service';

/**
 * `GET /logs/:id` — bajarse el log de C3 sin entrar al contenedor.
 *
 * En AWS el archivo vive en el disco efimero de la task, y la task muere en
 * cuanto se apaga el despliegue (T-07): el JSON se va con ella. Con 50 tenants
 * la alternativa es abrir 50 sesiones de exec para leer 50 archivos.
 *
 * ⚠ ESTE ENDPOINT ES DE UN TENANT. Cada contenedor sirve SU archivo y solo el
 * suyo — `<prueba>__<tenant>.json` —, porque un tenant no tiene por que poder
 * leer la medicion de otro. Los 50 se juntan pidiendoselo a los 50.
 *
 * ⚠ SIRVE EL ARCHIVO, NO LA MEMORIA. El volcado va cada FLUSH_MS (y se estira
 * a un minuto en corridas largas), asi que en mitad de una prueba el archivo
 * puede ir por detras. El dato al instante esta en `GET /status`, que se
 * reconstruye en cada llamada.
 */
@ApiTags('observabilidad')
@Controller('logs')
export class LogsController {
  constructor(private readonly registro: RegistroService) {}

  @ApiOperation({
    summary: 'Descarga `c3/logs/<id>__<tenant>.json`',
    description:
      'El log de ESTE tenant para esa prueba, tal como esta en disco, como adjunto.\n\n' +
      '`id` es el id de prueba: el mismo que viaja en la cabecera `x-prueba-id` de ' +
      '`POST /events` y que sale en `GET /status` como `pruebas[].prueba`. El sufijo ' +
      'del tenant lo pone el contenedor — no hace falta pasarlo, y no se puede pedir ' +
      'el de otro.\n\n' +
      '⚠ Es el ARCHIVO, no la memoria: en una corrida viva puede ir hasta un minuto ' +
      'por detras. El acumulado al instante esta en `/status`.',
  })
  @ApiParam({ name: 'id', example: 'final', description: 'Id de la prueba (`x-prueba-id`).' })
  @ApiResponse({
    status: 200,
    description: 'El JSON del log.',
    content: { 'application/json': { schema: { type: 'string', format: 'binary' } } },
  })
  @ApiResponse({ status: 400, description: 'Id con caracteres que no puede tener un nombre de archivo.' })
  @ApiResponse({ status: 404, description: 'No hay log con ese id. El cuerpo lista los que si hay.' })
  @Get(':id')
  descargar(@Param('id') id: string): StreamableFile {
    const prueba = sinSufijo(exigirId(id), this.registro.tenantId);
    return adjuntar(
      this.registro.carpeta,
      // UN SOLO CANDIDATO, y el sufijo lo pone el contenedor. Aceptar ademas
      // `<id>.json` a secas seria comodo —es lo que pega quien ya vio la
      // carpeta— pero en local los tenants COMPARTEN carpeta: pidiendo
      // `corrida__tenant-02` el archivo existiria y este endpoint serviria la
      // medicion del vecino. Con `sinSufijo` esa forma sigue funcionando, pero
      // resolviendo siempre al archivo propio.
      [basename(this.registro.ruta(prueba))],
      prueba,
      'C3 escribe el log al recibir trafico con esa `x-prueba-id`: si esta prueba ' +
        'no paso por este tenant, aqui no hay archivo — miralo en el tenant que si.',
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

/**
 * `corrida-1__tenant-01` → `corrida-1`, si el sufijo es el de ESTE tenant.
 *
 * Es la comodidad de pegar el nombre del archivo entero sin la fuga de
 * aceptarlo tal cual: el sufijo de otro tenant no se quita, asi que su archivo
 * no se llega a buscar nunca.
 */
function sinSufijo(id: string, tenant: string): string {
  const sufijo = `__${sanear(tenant)}`;
  return id.endsWith(sufijo) ? id.slice(0, -sufijo.length) : id;
}

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
 * Se manda con `Content-Length` para que el cliente sepa cuanto falta: el log
 * de una corrida larga pasa de los megas y una descarga sin tamaño no se
 * distingue de una colgada.
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
