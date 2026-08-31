/**
 * G-08 · Vuelca lo que C4 tiene, para poder conciliarlo contra lo que salio.
 *
 *   npm run informe -- [--prueba <id>] [--desde <ISO>] [--nombre <n>] [--salida <ruta>]
 *
 * Escribe `c4/logs/<nombre>__inbox.json`, que es la mitad "llegado" de P4. La
 * otra mitad la escribe el orquestador (`<prueba>__manifiesto.json`) y las
 * cruza `orquestador/src/cli/conciliar.ts`.
 *
 * ⚠ POR QUE UN CLI Y NO UN ENDPOINT. C4 no tiene servidor HTTP a proposito:
 * su unica entrada es la cola (D-03). Abrirle un puerto para consultar el
 * informe le añadiria una superficie que el diseño no contempla, y en la
 * cuenta del operador neutro. Esto corre despues de la corrida, contra la
 * base, y no toca el proceso que consume.
 *
 * ⚠ RECORTA, O EL VOLCADO MIENTE. La base de C4 sobrevive a la corrida: sin
 * corte, arrastra los expedientes de todas las pruebas anteriores y la
 * conciliacion los reporta como desconocidos por centenares. Hay dos cortes:
 *
 *   --prueba <id>   EXACTO. Filtra por la columna `inbox.prueba`, que es el id
 *                   de corrida que genero el orquestador y que viajo hasta
 *                   aqui en el MessageAttribute `prueba` del mensaje. Es el
 *                   que hay que usar: distingue dos corridas que se solapan y
 *                   no depende de acertar una hora.
 *   --desde <ISO>   APROXIMADO, por `e7_recibido`. El corte de antes de que el
 *                   id llegara hasta C4, y el unico que sirve para mensajes
 *                   publicados sin el atributo.
 *
 * Sin `--nombre`, el archivo toma el nombre de `--prueba` — asi
 * `<id>__inbox.json` queda al lado del `<id>__c4.json` que escribe el
 * consumidor y de los del orquestador y C3, y `npm run conciliar` los
 * encuentra sin que nadie tenga que renombrar nada.
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BdService } from '../bd/bd.service';
import { InboxRepository } from '../bd/inbox.repository';
import { ConfigService } from '../config/config.service';

function arg(nombre: string): string | null {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : null;
}

async function main(): Promise<void> {
  const desde = arg('desde');
  if (desde && Number.isNaN(Date.parse(desde))) {
    throw new Error(`--desde '${desde}' no es una fecha ISO valida`);
  }

  const prueba = arg('prueba');
  // El nombre por defecto es el id de corrida: es lo que hace que los cuatro
  // archivos de una prueba —orquestador, C3, y los dos de C4— compartan
  // prefijo. El sello de fecha solo aparece cuando no hay ni id ni nombre, que
  // es el volcado suelto de quien esta mirando la base a mano.
  const nombre = arg('nombre') ?? prueba ?? sello();

  // El ConfigService de C4 exige la cola porque el consumidor no existe sin
  // ella. Este CLI no lee de la cola: solo mira la base. Se le da un valor de
  // relleno para no duplicar la lectura de DATABASE_URL y C4_ESQUEMA, que son
  // las dos cosas que de verdad hacen falta aqui.
  process.env.SQS_QUEUE_URL ||= 'cli://informe-sin-cola';
  const config = new ConfigService();

  // Sin `onApplicationBootstrap()`: ese metodo CREA el esquema si no existe, y
  // un informe que se inventa un esquema vacio diria "no llego nada" cuando lo
  // que pasa es que apunta a la base equivocada.
  const bd = new BdService(config);
  const inbox = new InboxRepository(bd, config);

  try {
    const [expedientes, conciliacion, huecos] = await Promise.all([
      inbox.expedientes(desde, prueba),
      inbox.conciliacion(prueba),
      inbox.huecos(),
    ]);

    const volcado = {
      generado: new Date().toISOString(),
      esquema: config.bdEsquema,
      prueba,
      desde,
      totales: {
        inbox: expedientes.reduce((n, e) => n + e.vistos, 0),
        duplicados: expedientes.reduce((n, e) => n + e.duplicados, 0),
        expedientes: expedientes.length,
        descartes: Number(conciliacion.descartes ?? 0),
      },
      // G-05 tal cual lo ve C4: solo huecos interiores. Se incluye para poder
      // contrastarlo con lo que encuentra la conciliacion completa — la
      // diferencia entre los dos numeros ES el punto ciego de mirar solo aqui.
      huecos_interiores_vistos_por_c4: huecos.length,
      conciliacion_local: conciliacion,
      expedientes: expedientes.map((e) => ({
        rpf_id: e.rpf_id,
        sequences: e.sequences,
        duplicados: e.duplicados,
      })),
    };

    // La carpeta la decide el ConfigService (`C4_LOGS_DIR`), que es la misma
    // que sirve `GET /logs/:id`. `--salida` sigue mandando por encima, pero lo
    // que se deje ahi el endpoint no lo va a encontrar.
    const salida = arg('salida');
    const dir = salida ? resolve(salida) : config.dirLogs;
    mkdirSync(dir, { recursive: true });
    const destino = join(dir, `${nombre}__inbox.json`);

    // Temporal + rename: un volcado a medio escribir se leeria como un
    // volcado con expedientes ausentes, que es justo el hallazgo grave.
    writeFileSync(destino + '.tmp', JSON.stringify(volcado, null, 2) + '\n', 'utf8');
    renameSync(destino + '.tmp', destino);

    console.log(
      `${volcado.totales.expedientes} expediente(s) · ${volcado.totales.inbox} evento(s) unicos · ` +
      `${volcado.totales.duplicados} duplicado(s) · ${huecos.length} hueco(s) interior(es)\n${destino}`,
    );
    if (!prueba && !desde) {
      // Sin corte el volcado es la base ENTERA. No se falla —puede ser lo que
      // se queria— pero decirlo evita que alguien concilie una corrida contra
      // el acumulado de todas y lea el sobrante como eventos desconocidos.
      console.warn(
        '⚠ sin --prueba ni --desde: esto es TODA la base, no una corrida. ' +
        'La conciliacion de P4 contara como desconocidos los expedientes de pruebas anteriores.',
      );
    }
  } finally {
    await bd.onApplicationShutdown();
  }
}

function sello(): string {
  const t = new Date();
  const dd = (n: number) => String(n).padStart(2, '0');
  return `c4-${t.getFullYear()}${dd(t.getMonth() + 1)}${dd(t.getDate())}` +
         `-${dd(t.getHours())}${dd(t.getMinutes())}${dd(t.getSeconds())}`;
}

main().catch((e: unknown) => {
  console.error((e as Error).message);
  process.exit(1);
});
