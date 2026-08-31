/**
 * G-09 · el endpoint de salud de C4.
 *
 * Lo que se prueba no es que devuelva 200: es que `ok` siga a LA BASE. Un
 * health que contesta que si pase lo que pase es peor que no tenerlo — deja el
 * contenedor en verde mientras C4 saca mensajes de la cola y no los persiste.
 *
 * Corre contra una base DE MENTIRA, no contra Postgres: el caso que importa
 * —proceso vivo, base muerta— no se puede provocar contra una base real sin
 * tirar el contenedor.
 */
import { strict as assert } from 'node:assert';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { after, before, test } from 'node:test';
import { SaludController } from '../src/salud/salud.controller';
import { SaludService } from '../src/salud/salud.service';
import type { ConfigService } from '../src/config/config.service';
import type { BdService } from '../src/bd/bd.service';
import type { ConsumidorService } from '../src/consumidor/consumidor.service';
import type { RegistroService } from '../src/metricas/registro.service';

const PUERTO = 39_003;

/** La base contesta lo que le digamos, y cuenta cuantas veces la tocaron. */
class BaseFalsa {
  viva_responde = true;
  consultas = 0;
  async viva(): Promise<boolean> {
    this.consultas += 1;
    return this.viva_responde;
  }
}

const base = new BaseFalsa();

const config = {
  bdEsquema: 'c4',
  colaUrl: 'https://sqs.us-west-2.amazonaws.com/1/cola.fifo',
  dlqUrl: null,
  region: 'us-west-2',
  llavesFirmaAceptadas: new Set(['arn:aws:kms:us-west-2:1:key/abc']),
} as unknown as ConfigService;

const consumidor = {
  estado: () => ({
    corriendo: true,
    vacios_seguidos: 0,
    contadores: {
      recibidos: 7,
      borrados: 7,
      fallos_borrado: 0,
      ciclos: 3,
      ciclos_vacios: 1,
      errores: 0,
      bytes: 2048,
    },
  }),
} as unknown as ConsumidorService;

// El registro se sustituye por su forma minima: este test defiende que `ok`
// sigue a la BASE, y para eso no hace falta un reloj de verdad. Un
// RegistroService real abriria un timer y crearia la carpeta de logs.
const registro = { resumen: () => ({ logs: '/tmp', pruebas: [] }) } as unknown as RegistroService;

const servicio = new SaludService(
  config,
  base as unknown as BdService,
  consumidor,
  registro,
);

@Module({
  controllers: [SaludController],
  providers: [{ provide: SaludService, useValue: servicio }],
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

const pedir = async (ruta: string): Promise<{ estado: number; cuerpo: any }> => {
  const r = await fetch(`http://127.0.0.1:${PUERTO}${ruta}`);
  return { estado: r.status, cuerpo: r.status === 404 ? null : await r.json() };
};

test('/health dice ok:true cuando la base contesta', async () => {
  base.viva_responde = true;
  const { estado, cuerpo } = await pedir('/health');
  assert.equal(estado, 200);
  assert.equal(cuerpo.ok, true);
  assert.equal(cuerpo.base, true);
});

test('/health dice ok:false cuando la base NO contesta', async () => {
  // El caso entero por el que existe: proceso vivo, base muerta. Si `ok`
  // siguiera al proceso, esto seria verde y P4 daria de menos en silencio.
  base.viva_responde = false;
  const { estado, cuerpo } = await pedir('/health');
  // 200 a proposito: lo que dice la verdad es el cuerpo, no el codigo. Un
  // chequeo que solo mire el status tiene que fallar aqui, y por eso el
  // healthCheck de la task definition mira `ok`.
  assert.equal(estado, 200);
  assert.equal(cuerpo.ok, false);
  assert.equal(cuerpo.base, false);
  base.viva_responde = true;
});

test('/health CONSULTA la base, no devuelve un valor fijo', async () => {
  const antes = base.consultas;
  await pedir('/health');
  assert.equal(base.consultas, antes + 1);
});

test('el health dice que C4 no puede firmar (regla 7)', async () => {
  const { cuerpo } = await pedir('/health');
  assert.equal(cuerpo.puede_firmar, false);
});

test('/health lleva la cola, el esquema y el estado del consumidor', async () => {
  const { cuerpo } = await pedir('/health');
  assert.equal(cuerpo.cola, config.colaUrl);
  assert.equal(cuerpo.esquema, 'c4');
  assert.equal(cuerpo.llaves_firma_aceptadas, 1);
  assert.equal(cuerpo.consumidor.corriendo, true);
  assert.equal(cuerpo.consumidor.contadores.recibidos, 7);
});

test('/status no toca la base', async () => {
  const antes = base.consultas;
  const { estado, cuerpo } = await pedir('/status');
  assert.equal(estado, 200);
  assert.equal(base.consultas, antes);
  assert.equal(cuerpo.consumidor.contadores.ciclos, 3);
});

test('cualquier otra ruta es 404 · el ledger no se sirve por HTTP', async () => {
  // Los informes salen por CLI (G-08). Si algun dia aparece aqui un endpoint
  // que CONSULTE el ledger, este test tiene que fallar y obligar a decidirlo a
  // proposito.
  //
  // ⚠ `GET /logs/:id` no lo contradice: vive en LogsModule, abre el archivo
  // que ya escribio el CLI y no toca Postgres. La frontera que este test cuida
  // es la consulta, no el archivo.
  const { estado } = await pedir('/inbox');
  assert.equal(estado, 404);
});
