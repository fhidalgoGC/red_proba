/**
 * G-11 · Las metricas y el informe por segundo de C4.
 *
 * Sin cola, sin KMS y sin Postgres: lo que se prueba aqui es aritmetica y
 * forma de archivo. Los tramos que necesitan una base (`inbox`, `stamp`) se
 * ejercitan en inbox.test.ts y en `npm run e2e`, donde hay Postgres de verdad.
 *
 * Lo que de verdad se defiende:
 *
 *  1. que `init` y `completed` sean contadores DISTINTOS, en el lote Y en cada
 *     paso. Si el codigo los colapsara, el desfase —que es la latencia—
 *     desapareceria del informe sin que nada fallara.
 *  2. que un mensaje que se va por el camino del veneno o del reintento deje
 *     `message.init` sin su `completed`. Ese hueco es lo que dice EN QUE PASO
 *     se quedo, y sin el un descarte es indistinguible de un exito.
 *  3. que el id de corrida separe los archivos. C4 es UNO para los 50 tenants:
 *     si dos pruebas seguidas cayeran en el mismo archivo, la segunda
 *     arrastraria el trafico de la primera y P2 saldria inflada.
 *  4. que un id con forma rara no acabe en un nombre de archivo. A diferencia
 *     de C3, aqui el id no llega en una cabecera de una peticion propia: llega
 *     en un MessageAttribute que viaja en claro por una cola.
 *  5. que las reentregas de la cola se cuenten y NO se confundan con un error:
 *     la entrega es al-menos-una-vez (regla 4).
 */
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { agregar, comprimir, legible, presentarPaso, Serie, MUESTRAS_MAX } from '../src/metricas/muestras';
import { MetricasService, normalizar } from '../src/metricas/metricas.service';
import { RegistroService } from '../src/metricas/registro.service';
import type { ConfigService } from '../src/config/config.service';

// ─────────────────────────────────────────────────────────────────────────────
// Percentiles · la aritmetica que comparte con C3
// ─────────────────────────────────────────────────────────────────────────────

test('los percentiles de un segundo son exactos', () => {
  const r = comprimir([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(r.n, 10);
  assert.equal(r.p50, 5);
  assert.equal(r.p99, 10);
  assert.equal(r.suma, 55);
});

test('el techo recorta las muestras, NO la suma ni el conteo', () => {
  // En C4 este caso NO es hipotetico: los 50 tenants publican a una cola y
  // este proceso la consume solo, asi que el techo se alcanza en cuanto la
  // corrida pasa de 500 msg/s. Si `suma` saliera del array recortado,
  // `envelope+decrypt+verify+hash+inbox` dejaria de dar `message` justo en las
  // corridas grandes, que son las que interesan.
  const s = new Serie();
  for (let i = 0; i < MUESTRAS_MAX + 250; i++) s.push(2);

  const r = s.valor!;
  assert.equal(r.n, MUESTRAS_MAX + 250, 'las ejecuciones se cuentan todas');
  assert.equal(r.suma, (MUESTRAS_MAX + 250) * 2, 'la suma cubre todas');
  assert.equal(r.muestras, MUESTRAS_MAX, 'los percentiles salen de una parte');
});

// ⚠ Los dos que siguen son los invariantes que en C3 costaron una corrida
// entera (ver `c3/docs/07-medicion.md` · «Exactos y aproximados»). C4 heredo el
// codigo ya corregido pero no sus tests, asi que el fallo se podia reintroducir
// aqui sin que nada se pusiera rojo. Son los mismos dos de
// `c3/test/metricas.test.ts`, palabra por palabra en lo que afirman.

test('la Serie comprime y libera; comprimir dos veces no duplica', () => {
  const s = new Serie();
  for (const ms of [10, 20, 30]) s.push(ms);
  s.comprimir();
  s.comprimir();
  assert.equal(s.valor!.n, 3, 'la segunda compresion no debe volver a contar');
});

test('comprimir ACUMULA: un segundo comprimido a mitad no pierde muestras', () => {
  // El caso real: el volcado periodico comprime un segundo que sigue vivo y
  // despues le llegan mas muestras. La version que C3 tuvo que arreglar hacia
  // `resumen = comprimir(crudas)` y tiraba lo ya comprimido — se veia como
  // `completed: 30` con `n: 25`: cinco ejecuciones cuyo tiempo desaparecio del
  // informe sin un solo error. En C4 el volcado periodico es mas frecuente y
  // el trafico es el de los 50 tenants juntos: aqui se perderia mas.
  const s = new Serie();
  for (const ms of [10, 10, 10]) s.push(ms);
  s.comprimir();
  for (const ms of [20, 20]) s.push(ms);
  s.comprimir();

  const r = s.valor!;
  assert.equal(r.n, 5, 'las cinco, no las dos ultimas');
  assert.equal(r.suma, 70);
  assert.equal(r.min, 10);
  assert.equal(r.max, 20);
});

test('un tramo lento cae en DOS segundos: init en el suyo, completed en el siguiente', async () => {
  // Es la pregunta que provoca este archivo: ¿se guarda un instante y se
  // reutiliza para las dos columnas? No. Cada llamada lee el reloj cuando se
  // ejecuta, y por eso un tramo que cruza la frontera parte el par.
  const m = new MetricasService();
  m.abre('lento', 'decrypt');
  await new Promise((r) => setTimeout(r, 1100));
  m.cierra('lento', 'decrypt', 1100);

  const segs = m.segundosDe('lento');
  assert.equal(segs.length, 2, 'dos segundos distintos, no uno');
  assert.equal(segs[0]!.pasosInit.get('decrypt'), 1);
  assert.equal(segs[0]!.pasosFin.get('decrypt') ?? 0, 0, 'no habia terminado');
  assert.equal(segs[1]!.pasosInit.get('decrypt') ?? 0, 0);
  assert.equal(segs[1]!.pasosFin.get('decrypt'), 1);
  assert.equal(segs[1]!.pasosCruce.get('decrypt'), 1, 'y se declara como cruce');
});

test('cada ejecucion deja SU medida: n muestras distintas, no una repetida', () => {
  // Si se midiera una vez y se repitiera, `min` y `max` coincidirian y la suma
  // seria `n x p50`. Con medidas reales no puede pasar.
  const s = new Serie();
  for (const ms of [0.044, 0.071, 0.103, 0.19, 0.052]) s.push(ms);
  const r = s.valor!;
  assert.equal(r.n, 5);
  assert.equal(r.min, 0.044);
  assert.equal(r.max, 0.19);
  assert.notEqual(r.min, r.max, 'medir cinco veces no puede dar cinco veces lo mismo');
  assert.equal(r.suma, 0.46);
});

test('min y max son exactos y el techo NO los toca', () => {
  // Son la prueba, dentro de la propia fila, de que cada ejecucion se midio
  // por separado: un p50 solo no distingue un tramo que siempre tarda igual de
  // uno que oscila. Y como salen de `push` y no del array recortado, siguen
  // siendo ciertos cuando el techo tira muestras — que en C4 pasa siempre que
  // la corrida pasa de 500 msg/s.
  const s = new Serie();
  s.push(0.041);
  for (let i = 0; i < MUESTRAS_MAX + 250; i++) s.push(0.074);
  s.push(0.19);

  const r = s.valor!;
  assert.equal(r.min, 0.041, 'el mas rapido de TODAS, no de las muestras guardadas');
  assert.equal(r.max, 0.19, 'el mas lento de TODAS');
  assert.ok(r.muestras <= MUESTRAS_MAX, 'los percentiles si estan recortados');
});

test('agregar ventanas no degrada min ni max: son extremos, no percentiles', () => {
  const a = comprimir([5, 9]);
  const b = comprimir([1, 3]);
  const t = agregar([a, b])!;
  assert.equal(t.min, 1);
  assert.equal(t.max, 9);
  assert.equal(t.n, 4);
});

test('leer el valor NO comprime: un /status no degrada el segundo en curso', () => {
  const s = new Serie();
  for (const ms of [10, 20, 30]) s.push(ms);
  assert.equal(s.valor!.n, 3);
  s.push(40);
  assert.equal(s.valor!.n, 4, 'leer no puede haber cerrado nada');
});

test('los percentiles agregados se ponderan por muestras', () => {
  const chico = comprimir([100]);
  const grande = comprimir(Array(99).fill(10));
  const t = agregar([chico, grande])!;
  assert.ok(t.p50 < 12, `p50 ponderado deberia rondar 10,9 y salio ${t.p50}`);
});

test('un paso que empezo y no termino sale igual, con completed en 0', () => {
  // Es el caso que da todo el valor a `init`: sin muestras no hay `Resumen`,
  // pero el tramo SI ocurrio y es el que dice donde se quedo el mensaje.
  const p = presentarPaso({ init: 20, fin: 0 }, undefined)!;
  assert.equal(p.init, 20);
  assert.equal(p.completed, 0);
  assert.equal(p.suma_ms, 0);
});

test('legible acompaña al numero crudo, no lo sustituye', () => {
  assert.equal(legible(4692), '4.6 KB');
});

// ─────────────────────────────────────────────────────────────────────────────
// El id de corrida
// ─────────────────────────────────────────────────────────────────────────────

test('el id de corrida se sanea: llega de una cola, no de casa', () => {
  // ⚠ En C3 el id llega en una cabecera de una peticion que el propio tenant
  // recibio. Aqui llega en un MessageAttribute EN CLARO de un mensaje que
  // pudo publicar cualquiera que tenga permiso sobre la cola, y acaba en un
  // nombre de archivo del contenedor del operador neutro.
  assert.equal(normalizar('../../etc/passwd'), 'sin-id');
  assert.equal(normalizar(''), 'sin-id');
  assert.equal(normalizar(undefined), 'sin-id');
  assert.equal(normalizar('corrida-1'), 'corrida-1');
  assert.equal(normalizar(normalizar('x/y')), normalizar('x/y'), 'idempotente');
});

// ─────────────────────────────────────────────────────────────────────────────
// El informe
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Registro y Metricas se construyen a mano y no por Nest: al registro le basta
 * `dirLogs` del config y montar el modulo entero traeria la cola, KMS y la
 * base, que aqui no pintan nada.
 */
function informeDe(prueba: string, alimentar: (m: MetricasService) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'c4-metricas-'));
  const config = { dirLogs: dir } as unknown as ConfigService;

  const metricas = new MetricasService();
  alimentar(metricas);

  const registro = new RegistroService(metricas, config);
  registro.onModuleInit();
  // El cierre ordenado vuelca sin esperar los 45 s de silencio. Es el mismo
  // camino que corre con SIGTERM en Fargate.
  registro.onApplicationShutdown();

  const archivo = join(dir, `${prueba}__c4.json`);
  return { informe: JSON.parse(readFileSync(archivo, 'utf8')), registro, metricas, archivo };
}

test('el archivo se llama <prueba>__c4.json y trae total y seconds', () => {
  const { informe, archivo } = informeDe('pru01', (m) => {
    m.ciclo('pru01', false, 21.4);
    m.lote('pru01', 2, 9384);
    m.paso('pru01', 'wait', 0);
    m.paso('pru01', 'decrypt', 3.2);
    m.mensaje('pru01', 'persistido', 'h1', 3060);
    m.loteCompletado('pru01', 12.5);
  });

  // ⚠ El sufijo NO es decorativo: en la misma carpeta vive
  // `<prueba>__inbox.json`, que es el volcado del ledger (G-08). Sin sufijos
  // distintos, el CLI y el consumidor se pisarian el archivo.
  assert.ok(archivo.endsWith('pru01__c4.json'), archivo);
  assert.equal(informe.prueba, 'pru01');
  assert.equal(informe.rol, 'operador-neutro');
  assert.equal(informe.cerrado_por, 'apagado');
  assert.equal(informe.seconds.length, 1);
  assert.equal(informe.seconds[0].seg, 1, 'la serie empieza en 1, no en el epoch');
  assert.equal(informe.minutes, undefined, 'con 1 segundo, minutes seria una copia del total');
});

test('received, init y completed son TRES relojes, no tres nombres de lo mismo', () => {
  const { informe } = informeDe('pru02', (m) => {
    // Tres lotes entran (10 mensajes), a cuatro les toca el turno, dos
    // terminan, un lote cierra. Es exactamente lo que se ve cuando C4 se
    // atasca: el ritmo de entrada se mantiene y el de salida no.
    m.lote('pru02', 4, 12000);
    m.lote('pru02', 4, 12000);
    m.lote('pru02', 2, 6000);
    m.loteCompletado('pru02', 40.5);
    m.empieza('pru02');
    m.empieza('pru02');
    m.empieza('pru02');
    m.empieza('pru02');
    m.mensaje('pru02', 'persistido', 'a', 3000);
    m.mensaje('pru02', 'persistido', 'b', 3000);
  });

  const t = informe.total;
  assert.equal(t.batch.init, 3);
  assert.equal(t.batch.completed, 1);
  assert.equal(t.batch.latency_p50_ms, 40.5);
  assert.equal(t.batch.per_batch, 3.33, 'mensajes por lote, no mensajes a secas');
  assert.equal(t.messages.received, 10, 'llegaron en el lote');
  assert.equal(t.messages.init, 4, 'les toco el turno · NO son los recibidos');
  assert.equal(t.messages.completed, 2, 'solo los que llegaron a un desenlace');
  assert.equal(t.messages.bytes, 30000);
  assert.equal(t.messages.weight, '29.3 KB');
});

test('`empieza` mueve messages.init y message.init a la vez, nunca uno solo', () => {
  // Los dos cuentan el mismo hecho. Si se pudieran mover por separado, el
  // informe podria decir que empezaron 50 mensajes y que el tramo `message`
  // arranco 41 veces — y no habria forma de saber cual de los dos miente.
  const { informe } = informeDe('pru02b', (m) => {
    m.lote('pru02b', 3, 9000);
    m.empieza('pru02b');
    m.empieza('pru02b');
  });
  assert.equal(informe.total.messages.init, 2);
  assert.equal(informe.total.messages.steps.message.init, 2);
  assert.equal(informe.total.messages.received, 3, 'el tercero todavia no empezo');
});

test('wait y receive se declaran OBSERVADOS; los que C4 ejecuta, no', () => {
  // `wait` y `receive` son huecos entre dos instantes que ya pasaron cuando C4
  // se entera: su `init` y su `completed` son el mismo instante POR
  // DEFINICION, y nunca cruzaran un borde de segundo por larga que sea la
  // espera. Sin la bandera, `receive` con 127 ms de media y cero cruces se lee
  // como un reloj falso — que es exactamente la duda que este campo mata.
  const { informe } = informeDe('pru02c', (m) => {
    m.lote('pru02c', 1, 3000);
    m.ciclo('pru02c', false, 127);      // -> receive
    m.paso('pru02c', 'wait', 27);
    m.empieza('pru02c');
    m.paso('pru02c', 'decrypt', 0.07);
    m.cierra('pru02c', 'message', 5.7);
  });

  const s = informe.total.messages.steps;
  assert.equal(s.wait.observado, true);
  assert.equal(s.receive.observado, true);
  assert.equal(s.decrypt.observado, undefined, 'este SI lo ejecuta C4');
  assert.equal(s.message.observado, undefined);
  // Y lo que la bandera declara se cumple: en un observado los dos coinciden.
  assert.equal(s.wait.init, s.wait.completed);
  assert.equal(s.receive.init, s.receive.completed);
});

test('crossed dice cuantas de las que cerraron venian del segundo anterior', () => {
  // Es la respuesta directa a "init 50 / completed 50, ¿son los mismos 50?".
  // Se calcula desde la duracion —arranque = fin - ms—, sin guardar estado, y
  // por eso un tramo de 1.500 ms cuenta como cruce siempre y uno de 0,07 ms
  // casi nunca.
  const { informe } = informeDe('pru02d', (m) => {
    m.lote('pru02d', 3, 9000);
    m.empieza('pru02d');
    m.cierra('pru02d', 'message', 1500);   // 1,5 s: cruzo seguro
    m.empieza('pru02d');
    m.cierra('pru02d', 'message', 0.07);   // microsegundos: casi seguro que no
  });

  const s = informe.total.messages.steps.message;
  assert.equal(s.init, 2);
  assert.equal(s.completed, 2);
  assert.equal(s.crossed, 1, 'el de 1,5 s no pudo empezar en este segundo');
});

test('un paso que nunca cruza no arrastra el campo: se omite en 0', () => {
  // Un `crossed: 0` en cada paso de cada segundo son miles de lineas diciendo
  // que no paso nada. Ausente significa cero, igual que el resto del archivo.
  const { informe } = informeDe('pru02e', (m) => {
    m.lote('pru02e', 1, 3000);
    m.empieza('pru02e');
    m.cierra('pru02e', 'message', 0.05);
  });
  assert.equal(informe.total.messages.steps.message.crossed, undefined);
});

test('un lote que revienta no es completed y no mueve la latencia', () => {
  const { informe } = informeDe('pru03', (m) => {
    m.lote('pru03', 1, 3000);
    m.loteFallido('pru03');
  });

  const t = informe.total;
  assert.equal(t.batch.failed, 1);
  assert.equal(t.batch.completed, 0);
  assert.equal(t.batch.latency_p50_ms, null, 'el tiempo hasta un fallo no es tiempo de servicio');
});

test('un veneno deja message.init sin su completed: ahi se ve donde murio', () => {
  const { informe } = informeDe('pru04', (m) => {
    m.lote('pru04', 2, 6000);
    // El sano: abre y cierra los cinco tramos.
    m.empieza('pru04');
    m.paso('pru04', 'envelope', 0.1);
    m.paso('pru04', 'decrypt', 3);
    m.paso('pru04', 'verify', 1);
    m.paso('pru04', 'hash', 0.4);
    m.paso('pru04', 'inbox', 7);
    m.cierra('pru04', 'message', 11.5);
    m.mensaje('pru04', 'persistido', 'ok-1', 3000);
    // El veneno: la firma no verifica. `verify` abre y no cierra, y `message`
    // tampoco. Los dos huecos juntos dicen el paso exacto.
    m.empieza('pru04');
    m.paso('pru04', 'envelope', 0.1);
    m.paso('pru04', 'decrypt', 3);
    m.abre('pru04', 'verify');
    m.paso('pru04', 'dlq', 22);
    m.mensaje('pru04', 'descartado', null);
    m.dlq('pru04');
    m.loteCompletado('pru04', 40);
  });

  const s = informe.total.messages.steps;
  assert.equal(s.message.init, 2);
  assert.equal(s.message.completed, 1, 'el veneno no cierra el pipeline del mensaje');
  assert.equal(s.verify.init, 2);
  assert.equal(s.verify.completed, 1, 'aqui es donde se rompio');
  assert.equal(s.inbox.init, 1, 'el veneno nunca llego a la base');
  assert.equal(informe.total.messages.discarded, 1);
  assert.equal(informe.total.sqs.to_dlq, 1);
  // El camino del veneno se cronometra APARTE: metido en `message` inflaria la
  // latencia media con dos viajes de red que a un mensaje sano no le pasan.
  assert.equal(s.dlq.p50_ms, 22);
});

test('un mensaje sin hash no cuenta como unico ni como repetido', () => {
  const { informe } = informeDe('pru05', (m) => {
    m.lote('pru05', 1, 400);
    m.mensaje('pru05', 'descartado', null);   // no era ni un sobre
  });
  const t = informe.total.messages;
  assert.equal(t.discarded, 1);
  assert.equal(t.payload_hash_unicos, 0, 'mezclarlo con trafico legitimo falsearia P4');
  assert.equal(t.payload_hash_repetidos, 0);
});

test('las reentregas se cuentan contra TODA la corrida y no son un error', () => {
  const { informe } = informeDe('pru06', (m) => {
    m.lote('pru06', 1, 3000);
    m.mensaje('pru06', 'persistido', 'x', 3000);
    m.lote('pru06', 1, 3000);
    // El mismo payload_hash, otro lote: la cola lo reentrego y el inbox lo
    // absorbio. Es la regla 4 funcionando, no una anomalia.
    m.mensaje('pru06', 'duplicado', 'x', 3000);
  });

  const t = informe.total.messages;
  assert.equal(t.payload_hash_unicos, 1);
  assert.equal(t.payload_hash_repetidos, 1);
  assert.equal(t.persisted, 1);
  assert.equal(t.duplicated, 1, 'un duplicado NO es una perdida: es la idempotencia');
});

test('un paso sin muestras no aparece; los que hay salen en orden de pipeline', () => {
  const { informe } = informeDe('pru07', (m) => {
    m.lote('pru07', 1, 3000);
    // A proposito en desorden: el JSON tiene que salir en orden de pipeline —
    // un `inbox` antes de `decrypt` se lee como si el evento se hubiera
    // persistido antes de abrirlo.
    m.paso('pru07', 'inbox', 7);
    m.paso('pru07', 'decrypt', 3);
    m.paso('pru07', 'wait', 120);
    m.loteCompletado('pru07', 11);
  });

  const s = informe.total.messages.steps;
  assert.deepEqual(Object.keys(s), ['wait', 'decrypt', 'inbox']);
  assert.equal(s.verify, undefined, 'un paso que no ocurrio no debe salir a cero');
  assert.equal(s.wait.p50_ms, 120);
});

test('un sondeo en vacio NO mantiene viva una corrida que ya acabo', () => {
  // ⚠ ESTO COSTO UNA CORRIDA DE LOG. El lazo sigue sondeando para siempre
  // despues de que la prueba acabe. Si cada sondeo refrescara el reloj de
  // silencio, la corrida nunca se cerraria: `cerrado_por` se quedaria en "en
  // curso", `duracion_s` creceria sin parar y habria una fila por cada 20 s de
  // cola vacia. Medido en local: una corrida de 10 s aparecia con 259 s.
  const m = new MetricasService();
  m.lote('viva', 1, 100);
  m.loteCompletado('viva', 1);
  const antes = m.silencioDe('viva');
  m.ciclo('viva', true, null);
  assert.ok(m.silencioDe('viva') >= antes, 'un ciclo vacio no puede rejuvenecer la corrida');

  // Y de una corrida que nunca existio no se abre archivo: sin esto, un C4
  // arrancado antes que el orquestador dejaria en disco el log de una prueba
  // que no ocurrio.
  m.ciclo('fantasma', true, null);
  m.cicloFallido('fantasma');
  assert.ok(!m.pruebas.includes('fantasma'), m.pruebas.join(','));
});

test('un ciclo vacio se cuenta pero NO deja muestra de receive', () => {
  const { informe } = informeDe('pru08', (m) => {
    m.ciclo('pru08', false, 18.2);
    m.lote('pru08', 1, 3000);
    m.loteCompletado('pru08', 5);
    // Los 20 s que se pasa el long polling esperando son cola vacia, no coste
    // de C4: meterlos en `receive` empeoraria el p99 justo cuando va sobrado.
    m.ciclo('pru08', true, null);
    m.ciclo('pru08', true, null);
  });

  const t = informe.total;
  assert.equal(t.sqs.receives, 3);
  assert.equal(t.sqs.empty, 2);
  assert.equal(t.messages.steps.receive.n, 1, 'una muestra: la del ciclo que trajo algo');
  assert.equal(t.messages.steps.receive.p50_ms, 18.2);
});

test('KMS se cuenta aparte del tiempo: es la linea que decide si el cuello es KMS', () => {
  const { informe } = informeDe('pru09', (m) => {
    m.lote('pru09', 10, 30000);
    m.kms('pru09', { decrypt: 1, cache: 9 });
    m.kms('pru09', { pubkey: 1 });
    m.loteCompletado('pru09', 60);
  });

  const k = informe.total.kms;
  assert.equal(k.decrypt, 1, 'una data key por lote: el cache esta acertando');
  assert.equal(k.cache_hit, 9);
  assert.equal(k.get_public_key, 1);
});

test('el borrado fallido se cuenta: reaparecera como duplicado, no como error', () => {
  const { informe } = informeDe('pru10', (m) => {
    m.lote('pru10', 10, 30000);
    m.borrado('pru10', 8, 2);
    m.loteCompletado('pru10', 30);
  });
  assert.equal(informe.total.sqs.deleted, 8);
  assert.equal(informe.total.sqs.delete_failed, 2);
});

test('un id de corrida con forma rara no acaba en un nombre de archivo', () => {
  const { informe } = informeDe('sin-id', (m) => {
    m.lote('../../etc/passwd', 1, 3000);
    m.loteCompletado('../../etc/passwd', 1);
  });
  assert.equal(informe.prueba, 'sin-id');
});

test('dos corridas a la vez no se mezclan', () => {
  // C4 es UNO para los 50 tenants y la cola es compartida: dos corridas
  // solapadas es el caso normal cuando alguien lanza la siguiente sin esperar
  // a que se drene la anterior. Sumarlas inflaria P2 de la segunda.
  const { registro } = informeDe('pru11', (m) => {
    m.lote('pru11', 1, 1000);
    m.mensaje('pru11', 'persistido', 'a', 1000);
    m.loteCompletado('pru11', 1);
    m.lote('pru12', 2, 2000);
    m.mensaje('pru12', 'persistido', 'b', 1000);
    m.mensaje('pru12', 'persistido', 'c', 1000);
    m.loteCompletado('pru12', 2);
  });

  const r = registro.resumen();
  const a = r.pruebas.find((p) => p.prueba === 'pru11')!;
  const b = r.pruebas.find((p) => p.prueba === 'pru12')!;
  assert.equal(a.mensajes, 1);
  assert.equal(b.mensajes, 2);
  assert.equal(a.persistidos, 1);
  assert.equal(b.persistidos, 2);
});

test('/status se reconstruye: no devuelve el ultimo volcado', () => {
  // Entre dos volcados pueden pasar 60 s en una corrida larga. Un /status que
  // va un minuto por detras invita a creer que no esta llegando nada.
  const { registro, metricas } = informeDe('pru13', (m) => {
    m.lote('pru13', 1, 1000);
    m.mensaje('pru13', 'persistido', 'a', 1000);
    m.loteCompletado('pru13', 1);
  });

  metricas.lote('pru13', 5, 5000);
  const r = registro.resumen();
  assert.equal(r.pruebas.find((p) => p.prueba === 'pru13')!.mensajes, 6);
});
