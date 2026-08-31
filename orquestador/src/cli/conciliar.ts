/**
 * O-09 · Cruza el manifiesto contra el volcado de C4 y responde P4.
 *
 *   npm run conciliar -- <manifiesto.json> <inbox.json> [--salida <ruta>]
 *
 * Sale con codigo 1 si el veredicto no es `ok`, para que un script de corrida
 * pueda encadenarlo sin leer el JSON.
 *
 * ⚠ EL CRUCE ES LO QUE CIERRA EL PUNTO CIEGO. C4 sabe lo que llego pero no lo
 * que tenia que llegar: si falta la cola de un expediente, el rango que ve
 * sigue siendo denso y su consulta de huecos calla. El manifiesto trae el
 * rango emitido desde fuera, y la resta es la respuesta.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { conciliar } from '../conciliacion/conciliar';
import type { Manifiesto, VolcadoInbox } from '../conciliacion/tipos';

function arg(nombre: string): string | null {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : null;
}

function leer<T>(ruta: string, que: string): T {
  try {
    return JSON.parse(readFileSync(ruta, 'utf8')) as T;
  } catch (e) {
    throw new Error(`no se pudo leer el ${que} '${ruta}': ${(e as Error).message}`);
  }
}

const posicionales = process.argv.slice(2).filter((a, i, todos) =>
  !a.startsWith('--') && !(i > 0 && todos[i - 1]!.startsWith('--')));

const [rutaManifiesto, rutaInbox] = posicionales;

if (!rutaManifiesto || !rutaInbox) {
  console.error(
    'uso: npm run conciliar -- <manifiesto.json> <inbox.json> [--salida <ruta>]\n\n' +
    '  manifiesto.json  lo escribe el orquestador al cerrar la corrida\n' +
    '  inbox.json       lo escribe `npm run informe` en c4',
  );
  process.exit(2);
}

const manifiesto = leer<Manifiesto>(resolve(rutaManifiesto), 'manifiesto');
const inbox = leer<VolcadoInbox>(resolve(rutaInbox), 'volcado del inbox');

// ⚠ CRUZAR DOS CORRIDAS DISTINTAS DA UN RESULTADO QUE PARECE VALIDO.
//
// El volcado del inbox lleva ahora el id de corrida por el que se filtro
// (`--prueba`), asi que el desajuste se puede DETECTAR en vez de descubrirlo
// leyendo un residuo enorme y concluyendo que se perdieron mensajes. Se avisa
// y no se falla: conciliar a proposito el manifiesto de una prueba contra el
// volcado de otra es una comprobacion legitima, solo que rarisima.
if (inbox.prueba && inbox.prueba !== manifiesto.prueba) {
  console.warn(
    `⚠ el manifiesto es de '${manifiesto.prueba}' y el volcado del inbox de ` +
    `'${inbox.prueba}'. Todo lo que salga como faltante o desconocido es ese desajuste, ` +
    'no una perdida.',
  );
} else if (!inbox.prueba && !inbox.desde) {
  console.warn(
    '⚠ el volcado del inbox no lleva corte: es TODA la base de C4, no esta corrida. ' +
    'Los expedientes de pruebas anteriores saldran como desconocidos. ' +
    'Vuelve a correr `npm run informe -- --prueba <id>` en c4.',
  );
}

const v = conciliar(manifiesto, inbox);

const destino = resolve(
  arg('salida') ?? join(dirname(resolve(rutaManifiesto)), `${manifiesto.prueba}__conciliacion.json`),
);
mkdirSync(dirname(destino), { recursive: true });
writeFileSync(destino + '.tmp', JSON.stringify(v, null, 2) + '\n', 'utf8');
renameSync(destino + '.tmp', destino);

// ── El informe corto. El largo esta en el JSON. ─────────────────────────
const t = v.totales;
const n = (x: number) => x.toLocaleString('es');

console.log(`\nP4 · ${manifiesto.prueba}   (${basename(destino)})`);
console.log('─'.repeat(64));
console.log(`  emitidos          ${n(t.emitidos).padStart(12)}   entraron en una peticion`);
console.log(`  aceptados         ${n(t.aceptados).padStart(12)}   el destino contesto 2xx`);
console.log(`  llegados a C4     ${n(t.llegados).padStart(12)}   unicos`);
console.log(`  duplicados        ${n(t.duplicados).padStart(12)}   salud, no defecto`);
console.log(`  no emitidos       ${n(t.no_emitidos).padStart(12)}   nunca salieron: arnes`);
console.log('─'.repeat(64));
console.log(`  PERDIDA           ${n(v.clasificacion.perdida).padStart(12)}   aceptado y ausente en C4`);
console.log(`  sin confirmar     ${n(v.clasificacion.sin_confirmar).padStart(12)}   salio y nadie contesto`);
console.log(`  desconocidos      ${n(t.desconocidos).padStart(12)}   en C4 y no en el manifiesto`);
console.log('─'.repeat(64));
console.log(`  huecos interiores ${n(v.orden.expedientes_con_hueco_interior).padStart(12)}   ⚠ invalidan el orden`);
console.log(`  colas truncadas   ${n(v.orden.expedientes_truncados).padStart(12)}`);
console.log(`  expedientes idos  ${n(v.orden.expedientes_ausentes).padStart(12)}`);

if (v.detalle.length > 0) {
  console.log('\n  primeros expedientes con faltas:');
  for (const f of v.detalle.slice(0, 10)) {
    const r = f.faltan.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(',');
    console.log(`    ${f.rpf_id}  ${f.tenant}  ${f.forma.padEnd(14)} ${f.clasificacion.padEnd(13)} falta ${r}`);
  }
  if (v.detalle_omitido > 0) console.log(`    … y ${n(v.detalle_omitido)} expediente(s) mas en el JSON`);
}

for (const a of v.avisos) console.log(`\n  ⚠ ${a}`);

console.log(`\n  veredicto: ${v.ok ? 'OK' : 'NO OK'}\n`);
process.exit(v.ok ? 0 : 1);
