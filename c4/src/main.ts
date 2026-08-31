import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { INestApplicationContext } from '@nestjs/common';
import { AppModule } from './app.module';
import { ConfigService } from './config/config.service';
import { ConsumidorService } from './consumidor/consumidor.service';

/**
 * C4 no es un API: su unica ENTRADA es la cola FIFO (D-03) y su unica salida,
 * el Postgres. Lo unico que sirve por HTTP es su propia salud (G-09), y los
 * informes del ledger siguen saliendo por CLI (G-08) — abrirle un endpoint
 * para consultarlos le anadiria, en la cuenta del operador neutro, una
 * superficie que el diseno no contempla.
 *
 * `C4_PORT=0` vuelve a arrancarlo como contexto puro, sin abrir nada. Es como
 * corria antes de G-09 y como puede correr donde el health no haga falta.
 */
async function bootstrap(): Promise<void> {
  const puerto = Number(process.env.C4_PORT ?? 3003);
  const app: INestApplicationContext =
    puerto === 0 ? await NestFactory.createApplicationContext(AppModule, { bufferLogs: false })
                 : await servidor(puerto);

  // Sin esto, SIGTERM mata el proceso con un ReceiveMessage en vuelo: los
  // mensajes ya registrados quedan sin borrar y reaparecen. Con los hooks, el
  // consumidor drena el ciclo en curso dentro de los 30 s de Fargate.
  app.enableShutdownHooks();

  // Con C4_SALIR_TRAS_VACIOS el consumidor para solo cuando la cola lleva N
  // ciclos vacios seguidos. Es para drenar una corrida y salir; sin esto
  // habria que matar el proceso, y matarlo es justo lo que deja mensajes
  // procesados y sin borrar.
  const consumidor = app.get(ConsumidorService);
  await consumidor.terminado;
  await app.close();
}

async function servidor(puerto: number) {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  const config = app.get(ConfigService);

  const doc = new DocumentBuilder()
    .setTitle('C4 — Operador neutro · PoC RPF Proof Ledger')
    .setDescription(
      [
        'Consumidor del track `G`. **No es un API**: su unica entrada es la cola FIFO',
        '(D-03) y su unica salida, el Postgres. Lo unico que hay aqui es su salud.',
        '',
        '### Por que un worker tiene endpoint',
        'Porque un proceso vivo no dice nada. C4 puede estar corriendo con el Postgres',
        'caido y seguir sacando mensajes de la cola: los borraria **sin persistir** y P4',
        'daria de menos, sin un solo error en los logs. Por eso `ok` refleja LA BASE, no',
        'el proceso.',
        '',
        '⚠ Contesta 200 tambien con la base caida, con `ok:false` dentro. Mirar solo el',
        'codigo HTTP deja el contenedor en verde justo en el caso que esto existe para',
        'detectar.',
        '',
        '### Lo que C4 NO hace',
        '| | |',
        '|---|---|',
        '| Firmar | **Nunca** (regla 7). Descifra y verifica; `kms:Sign` no esta en su rol y la key policy lo niega |',
        '| Servir el ledger | Los informes salen por CLI: `npm run informe` (G-08) |',
        '| Consumir la DLQ | Mira su profundidad, jamas la vacia: seria destruir la evidencia (G-07) |',
        '',
        '### Donde termina la medicion',
        '`e10` se estampa **despues del COMMIT**, no cuando el INSERT retorna. Ese commit',
        'es el final del camino de un documento.',
      ].join('\n'),
    )
    .setVersion('0.1.0')
    .build();

  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, doc), {
    customSiteTitle: 'C4 — PoC RPF',
    swaggerOptions: { defaultModelsExpandDepth: 2, docExpansion: 'list', tryItOutEnabled: true },
  });

  // ⚠ Escucha en 127.0.0.1 salvo que C4_HEALTH_HOST diga otra cosa. El health
  // es para quien opera el contenedor —en AWS, el healthCheck de la propia
  // task—, no un endpoint del operador neutro publicado a la VPC: por eso la
  // task definition sigue sin portMappings y sin balanceador.
  await app.listen(puerto, config.hostSalud);
  new Logger('bootstrap').log(
    `C4 escucha en ${config.hostSalud}:${puerto} · Swagger http://localhost:${puerto}/docs`,
  );
  return app;
}

bootstrap().catch((e) => {
  // Sin SQS_QUEUE_URL no hay nada que medir. Morir aqui es mejor que quedar
  // vivo consumiendo de ninguna parte.
  console.error('el consumidor de C4 no pudo arrancar:', e);
  process.exit(1);
});
