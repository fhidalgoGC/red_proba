import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });

  // Sin esto, SIGTERM mata el proceso sin cerrar el pool de undici ni vaciar
  // los buffers: los eventos en vuelo quedarian contados como ofrecidos y
  // nunca como aceptados, y el deficit final seria mentira.
  app.enableShutdownHooks();

  // ORQ_PORT y no PORT: C3 tambien lee PORT para poder levantar 50 instancias
  // variandolo, y una sola variable compartida hace que exportarla mueva los
  // dos a la vez. Con nombres distintos no pueden chocar por accidente.
  const doc = new DocumentBuilder()
    .setTitle('Orquestador de carga — PoC RPF Proof Ledger')
    .setDescription(
      [
        'Driver de carga del track `O`. **Es andamio**: existe solo para la prueba.',
        '',
        'Genera los documentos fiscales, decide a que tenant le pega y cuando, y',
        'registra lo que ofrecio contra lo que le aceptaron.',
        '',
        '### Como se usa',
        '1. `POST /batch` lanza y devuelve **202 al momento** — no espera.',
        '2. `GET /batch/{id}` da el progreso mientras corre y el informe al terminar.',
        '',
        '### Las tres etapas, que no son lo mismo',
        '| | |',
        '|---|---|',
        '| `ofrecidos` | lo que el reloj pidio |',
        '| `enviados` | lo que salio al cable — **ENVIO**, es lo que gobierna `request` |',
        '| `aceptados` | lo que el destino confirmo — **TERMINACION** |',
        '',
        'Un sistema que se atasca mantiene el envio y hunde la terminacion. Si el',
        'arnes regulara por terminacion dejaria de presionar justo cuando empieza lo',
        'interesante — es omision coordinada, la forma mas comun de que una prueba de',
        'carga mienta.',
        '',
        '### Los logs, en los dos lados',
        '`orquestador/logs/<id>.json` (ofrecido) y `c3/logs/<id>__<tenant>.json`',
        '(recibido). Restarlos es lo que responde P4: desde un solo lado nunca puedes',
        'distinguir «no lo mande» de «lo mande y no llego».',
      ].join('\n'),
    )
    .setVersion('0.1.0')
    .build();

  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, doc), {
    customSiteTitle: 'Orquestador — PoC RPF',
    // Las corridas duran minutos; sin esto el navegador reordena la lista en
    // cada recarga y no encuentras el endpoint donde lo dejaste.
    swaggerOptions: { defaultModelsExpandDepth: 2, docExpansion: 'list', tryItOutEnabled: true },
  });

  const puerto = Number(process.env.ORQ_PORT ?? 3000);
  await app.listen(puerto, '0.0.0.0');

  new Logger('bootstrap').log(`orquestador en :${puerto} · Swagger http://localhost:${puerto}/docs`);
}

bootstrap().catch((e) => {
  // Un perfil mal formado tiene que matar el arranque, no producir una
  // corrida a medias cuyos numeros no se pueden defender.
  console.error('el orquestador no pudo arrancar:', e);
  process.exit(1);
});
