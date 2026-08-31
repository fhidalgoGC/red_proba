/**
 * `GET /logs/:id` — el informe de una corrida, servido como archivo.
 *
 * Es el unico endpoint que abre el disco a partir de algo que llega de fuera,
 * asi que lo que se prueba es el borde: que un id no pueda pasear por el
 * contenedor, y que el 404 diga que ids SI hay en vez de obligar a adivinar.
 */
import { strict as assert } from 'node:assert';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { LogsController } from '../src/metricas/logs.controller';
import { RegistroService } from '../src/metricas/registro.service';

const PUERTO = 39_012;

const dir = mkdtempSync(join(tmpdir(), 'orq-logs-'));

/** El registro de verdad, pero sin sus timers: aqui solo hace falta la ruta. */
const registro = {
  carpeta: dir,
  rutaDe: (prueba: string) => join(dir, `${prueba}.json`),
} as unknown as RegistroService;

writeFileSync(join(dir, 'corrida-1.json'), JSON.stringify({ prueba: 'corrida-1' }), 'utf8');
writeFileSync(join(dir, 'corrida-1__manifiesto.json'), JSON.stringify({ expedientes: [] }), 'utf8');

@Module({
  controllers: [LogsController],
  providers: [{ provide: RegistroService, useValue: registro }],
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

test('baja el informe con nombre de archivo y tamaño', async () => {
  const r = await pedir('/logs/corrida-1');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition') ?? '', /attachment; filename="corrida-1\.json"/);
  assert.equal(r.headers.get('content-type'), 'application/json');
  assert.ok(Number(r.headers.get('content-length')) > 0);
  assert.equal((await cuerpoDe(r)).prueba, 'corrida-1');
});

test('el manifiesto sale por el mismo endpoint', async () => {
  // No hace falta ruta propia: el archivo se llama `<id>.json` y el manifiesto
  // es `<id>__manifiesto`. La mitad "ofrecido" de P4 se baja igual que el
  // informe.
  const r = await pedir('/logs/corrida-1__manifiesto');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition') ?? '', /corrida-1__manifiesto\.json/);
});

test('un id que se sale de la carpeta no sirve un archivo de fuera', async () => {
  for (const id of ['..%2F..%2Fpackage', 'con%20espacio', 'nombre%00', '%2Fetc%2Fpasswd']) {
    const r = await pedir(`/logs/${id}`);
    assert.notEqual(r.status, 200, `${id} devolvio 200`);
  }
});

test('el 404 dice que ids SI hay', async () => {
  const r = await pedir('/logs/no-existe');
  assert.equal(r.status, 404);
  const cuerpo = await cuerpoDe(r);
  assert.deepEqual(cuerpo.buscado, ['no-existe.json']);
  assert.ok(cuerpo.disponibles.includes('corrida-1.json'));
});
