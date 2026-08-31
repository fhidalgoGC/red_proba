/**
 * Vuelca el pool de plantillas a disco, para poder mirarlo.
 *
 *   npm run volcar -- [carpeta]        (por defecto: salida/plantillas)
 *
 * ⚠ ESTO NO ES DE DONDE LEE EL ORQUESTADOR.
 *
 * En una corrida las plantillas viven SOLO en memoria: se construyen al
 * arrancar a partir de `pool.semilla` y no se lee ni se escribe ningun
 * archivo. Leerlas de disco añadiria I/O al camino critico del arnes, que es
 * exactamente lo que el pool existe para evitar.
 *
 * La reproducibilidad viene de la SEMILLA, no del archivo: con la misma
 * semilla salen las mismas 1.000 plantillas byte a byte. Este volcado es para
 * inspeccionar, comparar y adjuntar a un informe — no para alimentar la
 * corrida.
 *
 * El unico campo que NO se reproduce es `padding`: usa randomBytes a
 * proposito, porque su contenido no se firma y solo importa su largo.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { leerPerfil } from '../config/config.service';
import { canonicalize } from '../generador/jcs';
import { construirPlantilla, prng } from '../generador/payload';

const configDir = process.env.ORQ_CONFIG_DIR ?? join(process.cwd(), 'config');
const destino = resolve(process.argv[2] ?? join(process.cwd(), 'salida', 'plantillas'));

const perfil = leerPerfil(join(configDir, 'perfil.yaml'));
const { plantillas: n, semilla, tamanoBytes, itemsPorDocumento } = perfil.pool;

mkdirSync(destino, { recursive: true });

const r = prng(semilla);
const indice: string[] = ['archivo,bytes_canonicos,items,relleno'];
const histograma = new Map<number, number>();

for (let i = 0; i < n; i++) {
  const p = construirPlantilla(i, r, { tamanoBytes, itemsPorDocumento });
  const nombre = `plantilla-${String(i).padStart(4, '0')}-${p.bytes}B.json`;

  // Se escribe la forma CANONICA, no un JSON.stringify cualquiera: es la
  // forma sobre la que se mide el tamaño y sobre la que C3 va a firmar.
  writeFileSync(join(destino, nombre), canonicalize(p.doc) + '\n', 'utf8');

  const items = (p.doc.items as unknown[]).length;
  indice.push(`${nombre},${p.bytes},${items},${p.doc.padding.length}`);

  const cubeta = Math.floor(p.bytes / 256) * 256;
  histograma.set(cubeta, (histograma.get(cubeta) ?? 0) + 1);
}

writeFileSync(join(destino, 'indice.csv'), indice.join('\n') + '\n', 'utf8');

const bytes = indice.slice(1).map((l) => Number(l.split(',')[1]));
const total = bytes.reduce((a, b) => a + b, 0);

console.log(`${n} plantillas escritas en ${destino}`);
console.log(`semilla ${semilla} · rango pedido ${tamanoBytes[0]}-${tamanoBytes[1]} B · items ${itemsPorDocumento[0]}-${itemsPorDocumento[1]}`);
console.log(`tamaño real: min ${Math.min(...bytes)} · media ${Math.round(total / n)} · max ${Math.max(...bytes)} B`);
console.log('');
console.log('distribucion (cubetas de 256 B):');
for (const [cubeta, cuenta] of [...histograma].sort((a, b) => a[0] - b[0])) {
  const barra = '#'.repeat(Math.round((cuenta / n) * 200));
  console.log(`  ${String(cubeta).padStart(4)}-${String(cubeta + 255).padEnd(4)} B  ${String(cuenta).padStart(4)}  ${barra}`);
}
