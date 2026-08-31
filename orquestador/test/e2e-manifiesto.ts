/**
 * Punta a punta de O-08 y O-09, sin AWS y sin base de datos.
 *
 *   npm run e2e:manifiesto
 *
 * Levanta dos C3 de mentira, corre una corrida de verdad contra ellos y cruza
 * el manifiesto que sale con un inbox sintetico al que se le quitan eventos a
 * mano. Comprueba que la conciliacion encuentra EXACTAMENTE lo que se quito, y
 * -mas importante- que no encuentra nada cuando no falta nada.
 *
 * ⚠ POR QUE NO ES UN TEST UNITARIO MAS. Lo que se verifica aqui no es la resta
 * de rangos (eso ya lo cubre conciliar.test.ts) sino el CABLEADO: que el
 * manifiesto se alimente donde el evento sale por el cable, que las respuestas
 * 5xx caigan del lado de "sin confirmar" y no del de "perdida", y que el
 * volcado ocurra cuando ya no queda nada en vuelo. Los tres son errores que un
 * test unitario no puede ver y que producirian un P4 que miente.
 *
 * Fue esta prueba la que encontro que un hueco dejado por un 503 estaba
 * contando como hueco de orden.
 */
import { strict as assert } from 'node:assert';
import { execFileSync, spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createServer as crearSocket } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { aRangos } from '../src/conciliacion/rangos';
import type { Manifiesto, VolcadoInbox } from '../src/conciliacion/tipos';

// __dirname es `dist-test/test` en tiempo de ejecucion, no `test`: dos
// niveles arriba, no uno.
const RAIZ = resolve(__dirname, '..', '..');
const PUERTOS = { orq: 4800, c3a: 4801, c3b: 4802 };
const PRUEBA = 'e2e-manifiesto';
/** Una de cada N peticiones se rechaza con 503. */
const UNA_DE_CADA = 11;

interface Id { rpf_id: string; sequence: number }

const aceptados: Id[] = [];
const rechazados: Id[] = [];
let peticiones = 0;

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

function falsoC3(puerto: number): Promise<Server> {
  return new Promise((ok) => {
    const s = createServer((req, res) => {
      let cuerpo = '';
      req.on('data', (c) => { cuerpo += c; });
      req.on('end', () => {
        const { documentos } = JSON.parse(cuerpo) as { documentos: Id[] };
        const ids = documentos.map((d) => ({ rpf_id: d.rpf_id, sequence: d.sequence }));

        // Un 503 son eventos que salieron por el cable y que nadie confirmo:
        // tienen que acabar en `sin_confirmar`, jamas en `perdida`.
        if (++peticiones % UNA_DE_CADA === 0) {
          rechazados.push(...ids);
          res.writeHead(503).end('{"error":"simulado"}');
          return;
        }
        aceptados.push(...ids);
        res.writeHead(202, { 'content-type': 'application/json' }).end('{"ok":true}');
      });
    });
    s.listen(puerto, '127.0.0.1', () => ok(s));
  });
}

async function libre(puerto: number): Promise<boolean> {
  return new Promise((ok) => {
    const s = crearSocket();
    s.once('error', () => ok(false));
    s.listen(puerto, '127.0.0.1', () => s.close(() => ok(true)));
  });
}

function inboxSintetico(eventos: Id[], duplicadosPorExpediente: number): VolcadoInbox {
  const porRpf = new Map<string, number[]>();
  for (const e of eventos) {
    const ya = porRpf.get(e.rpf_id);
    if (ya) ya.push(e.sequence); else porRpf.set(e.rpf_id, [e.sequence]);
  }
  const expedientes = [...porRpf.entries()].map(([rpf_id, seqs]) => ({
    rpf_id, sequences: aRangos(seqs), duplicados: duplicadosPorExpediente,
  }));

  return {
    generado: new Date().toISOString(),
    esquema: 'c4',
    // Con corte temporal: sin el, un volcado real arrastraria corridas viejas.
    desde: new Date(Date.now() - 3600_000).toISOString(),
    totales: {
      inbox: eventos.length,
      duplicados: duplicadosPorExpediente * expedientes.length,
      expedientes: expedientes.length,
      descartes: 0,
    },
    expedientes,
  };
}

function conciliar(dir: string, rutaInbox: string, etiqueta: string): { codigo: number; salida: string } {
  const args = [
    join(RAIZ, 'dist-test/src/cli/conciliar.js'),
    join(dir, `${PRUEBA}__manifiesto.json`),
    rutaInbox,
    '--salida', join(dir, `${etiqueta}__conciliacion.json`),
  ];
  try {
    return { codigo: 0, salida: execFileSync('node', args, { encoding: 'utf8' }) };
  } catch (e) {
    const err = e as { status: number; stdout: string };
    return { codigo: err.status, salida: err.stdout ?? '' };
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  for (const p of Object.values(PUERTOS)) {
    if (!await libre(p)) throw new Error(`puerto ${p} ocupado: queda una corrida viva`);
  }

  const dir = mkdtempSync(join(tmpdir(), 'e2e-manifiesto-'));
  const config = join(dir, 'config');
  const logs = join(dir, 'logs');
  mkdirSync(config, { recursive: true });
  mkdirSync(logs, { recursive: true });

  writeFileSync(join(config, 'tenants.yaml'),
    `tenants:\n  - id: tenant-01\n    url: http://127.0.0.1:${PUERTOS.c3a}\n` +
    `  - id: tenant-02\n    url: http://127.0.0.1:${PUERTOS.c3b}\n`);
  writeFileSync(join(config, 'perfil.yaml'), readFileSync(join(RAIZ, 'config/perfil.yaml'), 'utf8'));

  const s1 = await falsoC3(PUERTOS.c3a);
  const s2 = await falsoC3(PUERTOS.c3b);

  const orq = spawn('node', [join(RAIZ, 'dist-test/src/main.js')], {
    env: { ...process.env, ORQ_PORT: String(PUERTOS.orq), ORQ_CONFIG_DIR: config, ORQ_LOGS_DIR: logs },
    stdio: ['ignore', 'ignore', process.env.VERBOSE ? 'inherit' : 'ignore'],
  });

  try {
    for (let i = 0; i < 80; i++) {
      try { await fetch(`http://127.0.0.1:${PUERTOS.orq}/health`); break; } catch { await dormir(250); }
    }

    // thread=10: expedientes de diez eventos. Con `eventos_por_hilo: 1` cada
    // evento seria su propio expediente y no habria orden que romper.
    const lanzar = await fetch(`http://127.0.0.1:${PUERTOS.orq}/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: PRUEBA, client: 'all', events: 300, seconds: 4, thread: 10, perRequest: 5 }),
    });
    assert.equal(lanzar.status, 202, 'el batch no arranco');

    // El manifiesto se escribe al CERRAR el informe, que es cuando ya no queda
    // nada en vuelo. Esperar a que exista no basta: hay que verlo drenado.
    let m: Manifiesto | null = null;
    for (let i = 0; i < 160; i++) {
      await dormir(500);
      try {
        const leido = JSON.parse(readFileSync(join(logs, `${PRUEBA}__manifiesto.json`), 'utf8')) as Manifiesto;
        if (leido.totales.en_vuelo === 0) { m = leido; break; }
      } catch { /* todavia no existe */ }
    }
    assert.ok(m, 'no se escribio el manifiesto');

    assert.equal(m.totales.emitidos, aceptados.length + rechazados.length,
      'el manifiesto tiene que contar lo mismo que recibieron los destinos');
    assert.equal(m.totales.aceptados, aceptados.length);
    assert.equal(m.totales.rechazados, rechazados.length);
    assert.equal(m.truncado, false);

    // ── 1. Llego todo lo aceptado ─────────────────────────────────────────
    const limpio = join(logs, 'inbox-limpio.json');
    writeFileSync(limpio, JSON.stringify(inboxSintetico(aceptados, 2)));
    const a = conciliar(logs, limpio, 'limpio');

    assert.equal(a.codigo, 0, `el caso limpio deberia salir OK:\n${a.salida}`);
    assert.match(a.salida, /PERDIDA\s+0/);
    // ⚠ La comprobacion que motivo un cambio de diseño: los 503 dejan huecos,
    // pero no son huecos de orden.
    assert.match(a.salida, /huecos interiores\s+0/, 'un 503 no puede acusar al orden');
    assert.match(a.salida, /colas truncadas\s+0/);
    assert.match(a.salida, new RegExp(`sin confirmar\\s+${rechazados.length}`));

    // ── 2. Se pierden eventos DESPUES de que el destino los aceptara ──────
    const porRpf = new Map<string, number[]>();
    for (const e of aceptados) {
      const ya = porRpf.get(e.rpf_id);
      if (ya) ya.push(e.sequence); else porRpf.set(e.rpf_id, [e.sequence]);
    }
    const completos = [...porRpf.entries()].filter(([, s]) => s.length >= 5).map(([r]) => r);
    assert.ok(completos.length >= 3, 'hacen falta tres expedientes con cuerpo para romperlos');

    const [cola, interior, entero] = completos as [string, string, string];
    const seqs = (r: string) => [...porRpf.get(r)!].sort((x, y) => x - y);
    const fuera = new Set<string>();
    seqs(cola).slice(-2).forEach((s) => fuera.add(`${cola}#${s}`));       // cola truncada
    fuera.add(`${interior}#${seqs(interior)[2]}`);                        // hueco interior
    seqs(entero).forEach((s) => fuera.add(`${entero}#${s}`));             // expediente entero

    const roto = join(logs, 'inbox-roto.json');
    writeFileSync(roto, JSON.stringify(
      inboxSintetico(aceptados.filter((e) => !fuera.has(`${e.rpf_id}#${e.sequence}`)), 0)));
    const b = conciliar(logs, roto, 'con-perdida');

    assert.equal(b.codigo, 1, 'el caso con perdida tiene que salir NO OK');
    assert.match(b.salida, new RegExp(`PERDIDA\\s+${fuera.size}`), b.salida);
    assert.match(b.salida, /huecos interiores\s+1/, b.salida);
    assert.match(b.salida, /colas truncadas\s+1/, b.salida);
    assert.match(b.salida, /expedientes idos\s+1/, b.salida);

    console.log(
      `✔ e2e manifiesto · ${m.totales.emitidos} emitidos · ${m.totales.aceptados} aceptados · ` +
      `${rechazados.length} rechazados · ${fuera.size} perdidas detectadas, ni una mas`,
    );
  } finally {
    await new Promise<void>((ok) => {
      orq.once('exit', () => ok());
      orq.kill('SIGTERM');
      setTimeout(() => orq.kill('SIGKILL'), 3000).unref();
    });
    s1.close(); s2.close();
    if (!process.env.CONSERVAR) rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((e: unknown) => {
  console.error((e as Error).message);
  process.exit(1);
});
