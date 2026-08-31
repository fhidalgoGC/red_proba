/**
 * `GET /logs/:id` — el volcado de G-08, servido como archivo.
 *
 * Tres cosas que hay que dejar clavadas, y ninguna es "devuelve 200":
 *
 *   1. NO consulta la base. Aqui no hay Postgres de mentira porque el
 *      controlador no lo pide: si algun dia se lo pidiera, este test no
 *      compilaria — y eso es justamente la barrera que interesa. C4 no expone
 *      el ledger por HTTP (D-03); expone un archivo que ya escribio el CLI.
 *   2. Un id no puede salirse de la carpeta. El id llega de fuera y se
 *      concatena a una ruta.
 *   3. El 404 dice que ids SI hay. Un 404 pelado obliga a adivinar.
 */
import { strict as assert } from 'node:assert';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { LogsController } from '../src/logs.controller';
import { ConfigService } from '../src/config/config.service';

const PUERTO = 39_013;

const dir = mkdtempSync(join(tmpdir(), 'c4-logs-'));
const config = { dirLogs: dir } as unknown as ConfigService;

// Lo que dejaria `npm run informe -- --prueba corrida-1`.
writeFileSync(join(dir, 'corrida-1__inbox.json'), JSON.stringify({ totales: { inbox: 7 } }), 'utf8');
// Y lo que deja el consumidor mientras corre (G-11). Coexisten a proposito y
// por eso llevan sufijos distintos: son cosas distintas y `/logs/<id>` tiene
// que dar el log, no el volcado del ledger.
writeFileSync(join(dir, 'ambas__c4.json'), JSON.stringify({ total: { batch: { init: 3 } } }), 'utf8');
writeFileSync(join(dir, 'ambas__inbox.json'), JSON.stringify({ totales: { inbox: 9 } }), 'utf8');
// Un directorio con nombre de log: statSync no falla, asi que si el
// controlador no comprobara isFile() serviria un EISDIR como si fuera un JSON.
mkdirSync(join(dir, 'trampa__inbox.json'));

@Module({
  controllers: [LogsController],
  providers: [{ provide: ConfigService, useValue: config }],
})
class ModuloDePrueba {}

let app: Awaited<ReturnType<typeof NestFactory.create>>;

before(async () => {
  app = await NestFactory.create(ModuloDePrueba, { logger: false });
  await app.listen(PUERTO, '127.0.0.1');
});
after(async () => {
  await app.close();
});

const pedir = (ruta: string) => fetch(`http://127.0.0.1:${PUERTO}${ruta}`);
const cuerpoDe = async (r: Response): Promise<any> => r.json();

test('baja el volcado del inbox con nombre de archivo y tamaño', async () => {
  const r = await pedir('/logs/corrida-1');
  assert.equal(r.status, 200);
  // Adjunto y con el nombre de verdad: `curl -OJ` lo guarda tal cual, que es
  // como se recogen los logs de 50 tenants sin renombrar a mano.
  assert.match(r.headers.get('content-disposition') ?? '', /attachment; filename="corrida-1__inbox\.json"/);
  assert.equal(r.headers.get('content-type'), 'application/json');
  // Sin Content-Length, una descarga de megas no se distingue de una colgada.
  assert.ok(Number(r.headers.get('content-length')) > 0);
  assert.equal((await cuerpoDe(r)).totales.inbox, 7);
});

test('acepta tambien el nombre completo del archivo', async () => {
  // El error natural de quien ya vio la carpeta. Un 404 ahi solo hace perder
  // el viaje.
  const r = await pedir('/logs/corrida-1__inbox');
  assert.equal(r.status, 200);
});

test('un id que se sale de la carpeta es 400, no un archivo de fuera', async () => {
  for (const id of ['..%2F..%2Fpackage', 'con%20espacio', 'nombre%00', '%2Fetc%2Fpasswd']) {
    const r = await pedir(`/logs/${id}`);
    assert.ok(r.status === 400 || r.status === 404, `${id} devolvio ${r.status}`);
    assert.notEqual(r.status, 200);
  }
});

test('un directorio con nombre de log no se sirve', async () => {
  const r = await pedir('/logs/trampa');
  assert.equal(r.status, 404);
});

test('con los dos archivos, /logs/<id> da el log por segundo y no el del ledger', async () => {
  // El orden de los candidatos ES el contrato: `/logs/<id>` significa "el log"
  // en los tres contenedores, y en C4 el log es el del consumidor. El volcado
  // del ledger se pide por su nombre, igual que el manifiesto del orquestador.
  const log = await pedir('/logs/ambas');
  assert.equal(log.status, 200);
  assert.match(log.headers.get('content-disposition') ?? '', /ambas__c4\.json/);

  const ledger = await pedir('/logs/ambas__inbox');
  assert.equal(ledger.status, 200);
  assert.match(ledger.headers.get('content-disposition') ?? '', /ambas__inbox\.json/);
});

test('sin log por segundo, /logs/<id> sigue dando el volcado del ledger', async () => {
  // Compatibilidad con lo que este endpoint hacia antes de G-11: quien ya
  // tiene `curl -OJ .../logs/<id>` en un script no deberia empezar a recibir
  // 404 porque el consumidor todavia no volco nada.
  const r = await pedir('/logs/corrida-1');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition') ?? '', /corrida-1__inbox\.json/);
});

test('el 404 dice que ids SI hay y como se producen', async () => {
  const r = await pedir('/logs/no-existe');
  assert.equal(r.status, 404);
  const cuerpo = await cuerpoDe(r);
  // Los tres candidatos, en orden: el log por segundo primero (G-11) y el
  // volcado del ledger despues (G-08). Salen los tres en el 404 porque un
  // "no hay nada" sin decir QUE se busco obliga a leer el codigo.
  assert.deepEqual(cuerpo.buscado, [
    'no-existe__c4.json',
    'no-existe__inbox.json',
    'no-existe.json',
  ]);
  assert.ok(cuerpo.disponibles.includes('corrida-1__inbox.json'));
  // El volcado lo escribe el CLI, no el consumidor: sin eso, un 404 se lee
  // como "no llego nada" cuando lo que falta es haber corrido el informe.
  assert.match(cuerpo.ayuda, /npm run informe/);
});
