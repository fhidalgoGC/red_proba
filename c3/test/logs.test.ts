/**
 * `GET /logs/:id` — el log de tiempos de C3, servido como archivo.
 *
 * Lo que hay que dejar clavado es el AISLAMIENTO: el sufijo del tenant lo pone
 * el contenedor, nunca la ruta. Si el id pudiera elegirlo, `tenant-01` podria
 * bajarse la medicion de `tenant-02` — 50 contenedores con una sola imagen y un
 * id que viene de fuera es exactamente donde eso se cuela.
 */
import { strict as assert } from 'node:assert';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { LogsController } from '../src/logs.controller';
import { RegistroService } from '../src/metricas/registro.service';

const PUERTO = 39_011;

const dir = mkdtempSync(join(tmpdir(), 'c3-logs-'));

/** El registro de verdad, pero sin sus timers ni su base: solo la ruta. */
const registro = {
  carpeta: dir,
  tenantId: 'tenant-01',
  ruta: (prueba: string) => join(dir, `${prueba}__tenant-01.json`),
} as unknown as RegistroService;

writeFileSync(join(dir, 'corrida-1__tenant-01.json'), JSON.stringify({ tenant: 'tenant-01' }), 'utf8');
// El log del vecino, en la misma carpeta: en local los tenants la comparten.
writeFileSync(join(dir, 'corrida-1__tenant-02.json'), JSON.stringify({ tenant: 'tenant-02' }), 'utf8');

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

test('baja el log de ESTE tenant con su nombre y su tamaño', async () => {
  const r = await pedir('/logs/corrida-1');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition') ?? '', /attachment; filename="corrida-1__tenant-01\.json"/);
  assert.ok(Number(r.headers.get('content-length')) > 0);
  assert.equal((await cuerpoDe(r)).tenant, 'tenant-01');
});

test('el id NO puede elegir el tenant · el sufijo lo pone el contenedor', async () => {
  // El archivo de tenant-02 EXISTE y esta en la misma carpeta —en local los
  // tenants la comparten—, asi que este es el caso que de verdad separa un
  // aislamiento de una promesa: pedirlo por su nombre completo tiene que dar
  // el de ESTE tenant o nada, nunca el ajeno.
  const r = await pedir('/logs/corrida-1__tenant-02');
  if (r.status === 200) {
    assert.equal((await cuerpoDe(r)).tenant, 'tenant-01', 'sirvio el log de otro tenant');
  } else {
    assert.equal(r.status, 404);
  }
});

test('el nombre completo del archivo PROPIO si resuelve', async () => {
  // La comodidad de pegar lo que se ve en la carpeta, sin la fuga: el sufijo
  // propio se quita y se sigue por el camino canonico.
  const r = await pedir('/logs/corrida-1__tenant-01');
  assert.equal(r.status, 200);
  assert.equal((await cuerpoDe(r)).tenant, 'tenant-01');
});

test('un id que se sale de la carpeta no sirve un archivo de fuera', async () => {
  for (const id of ['..%2F..%2Fpackage', 'con%20espacio', 'nombre%00', '%2Fetc%2Fpasswd']) {
    const r = await pedir(`/logs/${id}`);
    assert.notEqual(r.status, 200, `${id} devolvio 200`);
  }
});

test('el 404 dice que ids SI hay y por que puede faltar', async () => {
  const r = await pedir('/logs/no-existe');
  assert.equal(r.status, 404);
  const cuerpo = await cuerpoDe(r);
  assert.deepEqual(cuerpo.buscado, ['no-existe__tenant-01.json']);
  assert.ok(cuerpo.disponibles.includes('corrida-1__tenant-01.json'));
  // La prueba pudo no pasar por este tenant: el reparto Zipf deja tenants sin
  // una sola peticion, y ahi no hay archivo que bajar. Un 404 pelado se leeria
  // como "se perdio el log".
  assert.match(cuerpo.ayuda, /tenant/);
});
