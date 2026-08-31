import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ConsumidorService } from './consumidor/consumidor.service';

/**
 * C4 no expone endpoints: no es un API, es un worker. Su unica entrada es la
 * cola FIFO (D-03) y su unica salida son los logs y -cuando exista G-03- el
 * inbox. Por eso un contexto de aplicacion y no un servidor HTTP: nada
 * escucha en ningun puerto, que es lo que dice la task definition de
 * terraform/modules/c4 (sin portMappings, sin balanceador).
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: false });

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

bootstrap().catch((e) => {
  // Sin SQS_QUEUE_URL no hay nada que medir. Morir aqui es mejor que quedar
  // vivo consumiendo de ninguna parte.
  console.error('el consumidor de C4 no pudo arrancar:', e);
  process.exit(1);
});
