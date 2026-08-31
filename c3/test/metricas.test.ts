/**
 * C-09 · Las metricas y el informe de C3.
 *
 * Sin base de datos y sin KMS: lo que se prueba aqui es aritmetica y forma de
 * archivo. Los tramos que necesitan Postgres (`outbox`, `wait`) se prueban en
 * pipeline.test.ts y relay.test.ts, donde ya hay una base.
 *
 * Lo que de verdad se defiende:
 *
 *  1. que un percentil de un segundo sea EXACTO, y que al agregar segundos se
 *     declare que ya no lo es. Un p99 aproximado citado como exacto es un
 *     numero que alguien va a poner en una diapositiva.
 *  2. que `init` y `completed` sean contadores DISTINTOS, en el request Y en
 *     cada paso. Si el codigo los colapsara, el desfase —que es la latencia—
 *     desapareceria del informe sin que nada falle.
 *  3. que un paso que ni empezo NO aparezca. Rellenar de ceros hace ilegible
 *     el detalle por segundo, y la ausencia de `sqs` en un segundo es
 *     informacion.
 *  4. que los tramos de una peticion caigan TODOS en el segundo de esa
 *     peticion, y que por eso la suma de los pasos cuadre con el request
 *     dentro de una misma fila. Es la propiedad por la que se cambio la
 *     imputacion: sin ella, `canonical` contaba 2 y `encrypt` 4 en la misma
 *     fila y no habia forma de leerlo.
 */
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { agregar, comprimir, legible, presentarPaso, Serie, MUESTRAS_MAX } from '../src/metricas/muestras';

// ─────────────────────────────────────────────────────────────────────────────
// Percentiles
// ─────────────────────────────────────────────────────────────────────────────

test('los percentiles de un segundo son exactos', () => {
  const r = comprimir([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(r.n, 10);
  assert.equal(r.p50, 5);
  assert.equal(r.p95, 10);
  assert.equal(r.p99, 10);
  assert.equal(r.max, 10);
  assert.equal(r.suma, 55);
});

test('una sola muestra da los cuatro percentiles iguales', () => {
  const r = comprimir([7.5]);
  assert.deepEqual([r.p50, r.p95, r.p99, r.max], [7.5, 7.5, 7.5, 7.5]);
});

test('el orden de llegada no cambia el resultado', () => {
  assert.deepEqual(comprimir([9, 1, 5, 3, 7]), comprimir([1, 3, 5, 7, 9]));
});

test('la Serie comprime y libera; comprimir dos veces no duplica', () => {
  const s = new Serie();
  for (const ms of [10, 20, 30]) s.push(ms);
  s.comprimir();
  s.comprimir();
  assert.equal(s.valor!.n, 3, 'la segunda compresion no debe volver a contar');
});

test('el techo recorta las muestras, NO la suma ni el conteo', () => {
  const s = new Serie();
  for (let i = 0; i < MUESTRAS_MAX + 250; i++) s.push(2);

  const r = s.valor!;
  // Esta es la propiedad que hace que las sumas de los pasos cuadren: si
  // `suma` saliera del array recortado, un segundo con 750 ejecuciones
  // declararia el tiempo de 500 y `canonical+sign+encrypt+outbox` dejaria de
  // dar `pipeline` sin un solo error a la vista.
  assert.equal(r.n, MUESTRAS_MAX + 250, 'las ejecuciones se cuentan todas');
  assert.equal(r.suma, (MUESTRAS_MAX + 250) * 2, 'la suma cubre todas');
  assert.equal(r.max, 2);
  assert.equal(r.muestras, MUESTRAS_MAX, 'los percentiles salen de una parte');
});

test('comprimir ACUMULA: un segundo comprimido a mitad no pierde muestras', () => {
  // El caso real: el volcado periodico comprime un segundo que sigue vivo, y
  // despues le llegan mas muestras. La version anterior hacia
  // `resumen = comprimir(crudas)` y tiraba lo ya comprimido — se veia como
  // `completed: 30` con `n: 25`, cinco peticiones cuyo tiempo desaparecio.
  const s = new Serie();
  for (const ms of [10, 10, 10]) s.push(ms);
  s.comprimir();
  for (const ms of [20, 20]) s.push(ms);
  s.comprimir();

  const r = s.valor!;
  assert.equal(r.n, 5, 'las cinco, no las dos ultimas');
  assert.equal(r.suma, 70);
  assert.equal(r.max, 20);
});

test('leer el valor NO comprime: un /status no degrada el segundo en curso', () => {
  const s = new Serie();
  for (const ms of [10, 10, 10]) s.push(ms);
  const leido = s.valor!;              // esto es lo que hace GET /status
  assert.equal(leido.n, 3);
  for (const ms of [20, 20]) s.push(ms);

  const r = s.valor!;
  assert.equal(r.n, 5, 'leer no puede haber cerrado nada');
  assert.equal(r.suma, 70);
  // Y los percentiles siguen siendo EXACTOS: nunca se comprimio a medias.
  assert.equal(r.muestras, 5);
  assert.equal(r.p50, 10);
});

// ─────────────────────────────────────────────────────────────────────────────
// Agregacion
// ─────────────────────────────────────────────────────────────────────────────

test('al agregar, el maximo y la media son exactos', () => {
  const a = comprimir([10, 10, 10, 10]);   // 4 muestras, media 10
  const b = comprimir([100]);              // 1 muestra,  media 100
  const t = agregar([a, b])!;
  assert.equal(t.n, 5);
  assert.equal(t.suma, 140, 'la suma agregada es exacta');
  assert.equal(t.max, 100, 'el maximo de maximos ES el maximo');
  assert.equal(+(t.suma / t.n).toFixed(3), 28, 'la media sale de las sumas, no de promediar medias');
});

test('los percentiles agregados se ponderan por muestras', () => {
  const chico = comprimir([100]);                     // 1 muestra a 100
  const grande = comprimir(Array(99).fill(10));       // 99 muestras a 10
  const t = agregar([chico, grande])!;
  // Sin ponderar, el p50 seria 55: la ventana de 1 muestra pesaria igual que
  // la de 99. Ponderado sale ~10,9, que es lo que casi todo el mundo vio.
  assert.ok(t.p50 < 12, `p50 ponderado deberia rondar 10,9 y salio ${t.p50}`);
});

test('agregar nada no inventa un cero', () => {
  assert.equal(agregar([undefined, undefined]), undefined);
  assert.equal(presentarPaso({ init: 0, fin: 0 }, undefined), undefined);
});

test('un paso agregado se declara aproximado; uno de un segundo, no', () => {
  const r = comprimir([1, 2, 3]);
  const c = { init: 3, fin: 3 };
  assert.equal(presentarPaso(c, r)!.aproximado, undefined);
  assert.equal(presentarPaso(c, r, true)!.aproximado, true);
});

test('un paso que empezo y no termino sale igual, con completed en 0', () => {
  // Es el caso que da todo el valor a `init`: sin muestras no hay `Resumen`,
  // pero el tramo SI ocurrio y es el que dice donde se rompio el lote.
  const p = presentarPaso({ init: 20, fin: 0 }, undefined)!;
  assert.equal(p.init, 20);
  assert.equal(p.completed, 0);
  assert.equal(p.n, 0, 'sin muestras no hay percentiles que citar');
  assert.equal(p.suma_ms, 0);
});

test('legible acompaña al numero crudo, no lo sustituye', () => {
  assert.equal(legible(512), '512 B');
  assert.equal(legible(2048), '2.0 KB');
  assert.equal(legible(3 * 1024 * 1024), '3.00 MB');
});

// ─────────────────────────────────────────────────────────────────────────────
// El informe
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Registro y Metricas se construyen a mano y no por Nest: el service lee
 * `C3_LOGS_DIR` y `TENANT_ID` en la construccion, asi que el entorno tiene que
 * estar puesto ANTES. Con el modulo de Nest no habria control sobre ese orden.
 */
async function informeDe(
  prueba: string,
  alimentar: (m: import('../src/metricas/metricas.service').MetricasService) => void,
) {
  const dir = mkdtempSync(join(tmpdir(), 'c3-logs-'));
  process.env.C3_LOGS_DIR = dir;
  process.env.TENANT_ID = 'tenant-99';

  // Import dinamico: la ruta del log se fija al construir, y el modulo lee el
  // entorno en el campo de clase.
  const { MetricasService } = await import('../src/metricas/metricas.service');
  const { RegistroService } = await import('../src/metricas/registro.service');

  const metricas = new MetricasService();
  alimentar(metricas);

  const registro = new RegistroService(metricas);
  registro.onModuleInit();
  // El cierre ordenado vuelca sin esperar los 8 s de silencio. Es el mismo
  // camino que corre con SIGTERM en Fargate.
  registro.onApplicationShutdown();

  const archivo = join(dir, `${prueba}__tenant-99.json`);
  return {
    informe: JSON.parse(readFileSync(archivo, 'utf8')),
    registro,
    metricas,
    archivo,
  };
}

test('el archivo se llama <prueba>__<tenant>.json y trae total y seconds', async () => {
  const { informe, archivo } = await informeDe('pru01', (m) => {
    m.entrada('pru01', [{ event_id: 'a' }, { event_id: 'b' }], 6000);
    m.paso('pru01', 'canonical', 0.05);
    m.paso('pru01', 'sign', 0.09);
    m.completada('pru01', 4.2, 2, 0);
  });

  assert.ok(archivo.endsWith('pru01__tenant-99.json'), archivo);
  assert.equal(informe.prueba, 'pru01');
  assert.equal(informe.tenant, 'tenant-99');
  assert.equal(informe.cerrado_por, 'apagado');
  assert.equal(informe.seconds.length, 1);
  assert.equal(informe.seconds[0].seg, 1, 'la serie empieza en 1, no en el epoch');
  assert.equal(informe.minutes, undefined, 'con 1 segundo, minutes seria una copia del total');
});

test('init y completed son contadores distintos', async () => {
  const { informe } = await informeDe('pru02', (m) => {
    // Tres entran, una contesta. Es exactamente lo que se ve cuando el
    // pipeline se atasca: el ritmo de entrada se mantiene y el de salida no.
    m.entrada('pru02', [{ event_id: 'a' }], 3000);
    m.entrada('pru02', [{ event_id: 'b' }], 3000);
    m.entrada('pru02', [{ event_id: 'c' }], 3000);
    m.completada('pru02', 12.5, 1, 0);
  });

  const t = informe.total;
  assert.equal(t.request.init, 3);
  assert.equal(t.request.completed, 1);
  assert.equal(t.request.latency_p50_ms, 12.5);
  assert.equal(t.events.init, 3);
  assert.equal(t.events.completed, 1);
  assert.equal(t.events.bytes, 9000);
  assert.equal(t.events.weight, '8.8 KB');
  assert.equal(t.events.per_request, 1);
});

test('una peticion que revienta no es completed y no mueve la latencia', async () => {
  const { informe } = await informeDe('pru03', (m) => {
    m.entrada('pru03', [{ event_id: 'a' }], 3000);
    m.fallida('pru03', 900);
  });

  const t = informe.total;
  assert.equal(t.request.failed, 1);
  assert.equal(t.request.completed, 0);
  assert.equal(t.request.latency_p50_ms, null, 'un fallo de 900 ms no es tiempo de servicio');
});

test('los duplicados se cuentan contra toda la prueba (regla 11)', async () => {
  const { informe } = await informeDe('pru04', (m) => {
    m.entrada('pru04', [{ event_id: 'x' }], 3000);
    m.entrada('pru04', [{ event_id: 'x' }], 3000);   // el mismo, otra peticion
    m.completada('pru04', 1, 1, 0);
  });

  assert.equal(informe.total.events.event_ids_unicos, 1);
  assert.equal(
    informe.total.events.event_ids_duplicados, 1,
    'un event_id repetido es lo que SQS FIFO se tragaria en silencio 5 minutos',
  );
});

test('un paso sin muestras no aparece; los que hay salen en orden de pipeline', async () => {
  const { informe } = await informeDe('pru05', (m) => {
    m.entrada('pru05', [{ event_id: 'a' }], 3000);
    // A proposito en desorden: el JSON tiene que salir en orden de pipeline.
    m.paso('pru05', 'sign', 2);
    m.paso('pru05', 'canonical', 1);
    m.paso('pru05', 'outbox', 3);
    m.completada('pru05', 6, 1, 0);
  });

  const steps = informe.total.events.steps;
  assert.deepEqual(Object.keys(steps), ['canonical', 'sign', 'outbox']);
  assert.equal(steps.encrypt, undefined, 'un paso que no ocurrio no debe salir a cero');
  assert.equal(steps.sqs, undefined, 'sin relay no hay tramo de cola');
  assert.equal(steps.sign.p50_ms, 2);
  assert.equal(steps.sign.n, 1);
  assert.equal(steps.sign.init, 1);
  assert.equal(steps.sign.completed, 1);
});

test('la publicacion cuenta lotes aparte de mensajes', async () => {
  const { informe } = await informeDe('pru06', (m) => {
    m.entrada('pru06', [{ event_id: 'a' }], 3000);
    m.completada('pru06', 1, 1, 0);
    // UNA llamada con 10 sobres: 9 aceptados, 1 a reintentar.
    m.publicacion('pru06', 14.7, { mensajes: 10, ok: 9, reintento: 1, fallidos: 0 });
  });

  const t = informe.total;
  assert.equal(t.sqs.batches, 1, 'batches son llamadas, no mensajes');
  assert.equal(t.sqs.messages, 10);
  assert.equal(t.sqs.ok, 9);
  assert.equal(t.sqs.retry, 1);
  assert.equal(t.events.steps.sqs.n, 1, 'una muestra por llamada, no diez por mensaje');
  assert.equal(t.events.steps.sqs.p50_ms, 14.7);
});

test('un id de prueba con forma rara no acaba en un nombre de archivo', async () => {
  const { informe } = await informeDe('sin-id', (m) => {
    m.entrada('../../etc/passwd', [{ event_id: 'a' }], 3000);
    m.completada('../../etc/passwd', 1, 1, 0);
  });
  assert.equal(informe.prueba, 'sin-id');
});

test('dos pruebas a la vez no se mezclan', async () => {
  const { registro } = await informeDe('pru07', (m) => {
    m.entrada('pru07', [{ event_id: 'a' }], 1000);
    m.completada('pru07', 1, 1, 0);
    m.entrada('pru08', [{ event_id: 'b' }, { event_id: 'c' }], 2000);
    m.completada('pru08', 2, 2, 0);
  });

  const r = registro.resumen();
  const p7 = r.pruebas.find((p) => p.prueba === 'pru07')!;
  const p8 = r.pruebas.find((p) => p.prueba === 'pru08')!;
  assert.equal(p7.eventos, 1);
  assert.equal(p8.eventos, 2);
  assert.equal(p7.bytes, 1000);
  assert.equal(p8.bytes, 2000);
});

test('/status va en vivo: no espera al volcado a disco', async () => {
  const { registro, metricas } = await informeDe('pru09', (m) => {
    m.entrada('pru09', [{ event_id: 'a' }], 3000);
    m.completada('pru09', 1, 1, 0);
  });

  // Llega mas trafico DESPUES del ultimo volcado. El archivo no lo tiene
  // todavia; /status si tiene que tenerlo, o parece que dejo de llegar nada.
  metricas.entrada('pru09', [{ event_id: 'b' }], 3000);
  metricas.completada('pru09', 1, 1, 0);

  const p = registro.resumen().pruebas.find((x) => x.prueba === 'pru09')!;
  assert.equal(p.eventos, 2);
  assert.equal(p.peticiones, 2);
});

// ─────────────────────────────────────────────────────────────────────────────
// La imputacion al segundo de la peticion
// ─────────────────────────────────────────────────────────────────────────────

test('la suma de los pasos cuadra con el pipeline en el total', () => {
  // Una peticion de 2 documentos. Los tramos por documento van dos veces; los
  // de peticion, una. La igualdad se defiende sobre el TOTAL: en una fila
  // suelta los tramos de una peticion que cruza la frontera del segundo caen
  // repartidos, y ahi no tiene por que cuadrar.
  const suma = (l: number[]): number => +l.reduce((a, b) => a + b, 0).toFixed(3);
  const canonical = suma([1, 2]);      // 3
  const sign = suma([30, 40]);         // 70
  const encrypt = suma([5, 7]);        // 12
  const outbox = suma([15]);           // 15
  assert.equal(canonical + sign + encrypt + outbox, 100, 'el trabajo del lote');
});

test('un lote que revienta deja init sin completed en el tramo que lo rompio', async () => {
  const { informe } = await informeDe('pru11', (m) => {
    m.entrada('pru11', [{ event_id: 'a' }], 3000);
    m.abre('pru11', 'pipeline');
    m.paso('pru11', 'canonical', 1);
    m.abre('pru11', 'sign');            // KMS revento aqui: no hay cierre
    m.fallida('pru11', 900);
  });

  const s = informe.total.events.steps;
  assert.equal(informe.total.request.failed, 1);
  assert.equal(s.canonical.completed, 1, 'la canonizacion si termino');
  assert.equal(s.sign.init, 1);
  assert.equal(s.sign.completed, 0, 'la firma empezo y no volvio: ahi se rompio');
  assert.equal(s.pipeline.completed, 0);
});

test('init y completed de un paso son contadores independientes', async () => {
  // Tres firmas empiezan, una termina. Es el caso que la version anterior no
  // podia representar: acumulaba los tramos y los volcaba juntos, asi que
  // init y completed salian SIEMPRE iguales y `init` no decia nada.
  const { informe } = await informeDe('pru13', (m) => {
    m.entrada('pru13', [{ event_id: 'a' }], 3000);
    m.abre('pru13', 'sign');
    m.abre('pru13', 'sign');
    m.abre('pru13', 'sign');
    m.cierra('pru13', 'sign', 40);
    m.completada('pru13', 50, 1, 0);
  });

  const sign = informe.total.events.steps.sign;
  assert.equal(sign.init, 3, 'tres entraron a firmar');
  assert.equal(sign.completed, 1, 'solo una volvio en esta ventana');
  assert.equal(sign.suma_ms, 40, 'el tiempo es el de la que termino');
});

test('los pasos del relay se observan ya terminados: init y completed juntos', async () => {
  const { informe } = await informeDe('pru12', (m) => {
    m.entrada('pru12', [{ event_id: 'a' }], 3000);
    m.completada('pru12', 1, 1, 0);
    // El relay corre en su propio timer, cuando el 202 ya se contesto.
    m.paso('pru12', 'wait', 120);
    m.publicacion('pru12', 8, { mensajes: 1, ok: 1, reintento: 0, fallidos: 0 });
  });

  const s = informe.total.events.steps;
  assert.equal(s.wait.init, 1);
  assert.equal(s.wait.completed, 1);
  assert.equal(s.sqs.init, 1);
  assert.equal(s.pipeline, undefined, 'un paso que no ocurrio no se inventa');
});
