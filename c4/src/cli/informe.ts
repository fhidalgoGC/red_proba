/**
 * G-08 · Vuelca lo que C4 tiene, para poder conciliarlo contra lo que salio.
 *
 *   npm run informe -- [--desde <ISO>] [--nombre <prueba>] [--salida <ruta>]
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
 * ⚠ USA `--desde`. La base de C4 sobrevive a la corrida: sin corte temporal
 * el volcado arrastra los expedientes de todas las pruebas anteriores y la
 * conciliacion los reporta como desconocidos por centenares.
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

  const nombre = arg('nombre') ?? sello();

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
      inbox.expedientes(desde),
      inbox.conciliacion(),
      inbox.huecos(),
    ]);

    const volcado = {
      generado: new Date().toISOString(),
      esquema: config.bdEsquema,
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

    const dir = resolve(arg('salida') ?? process.env.C4_LOGS_DIR ?? join(__dirname, '..', '..', 'logs'));
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
