import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { json } from 'express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // El limite por defecto de express son 100 KB. Un lote de 40 documentos de
  // 3 KB pasa de eso y el orquestador recibiria 413 en vez de 202 — y lo
  // contaria como rechazo del sistema cuando en realidad es config del arnes.
  app.use(json({
    limit: '16mb',
    // Se guarda el cuerpo crudo para poder medir los bytes QUE VIAJARON por el
    // cable. Re-serializar el objeto ya parseado daria un numero parecido pero
    // distinto, y el cable es lo que se esta midiendo.
    verify: (req, _res, buf) => { (req as any).rawBody = buf; },
  }));
  app.enableShutdownHooks();

  // PORT sigue valiendo porque en local se levantan varias instancias
  // variandolo. C3_PORT tiene prioridad para poder fijarlo sin tocar PORT.
  const doc = new DocumentBuilder()
    .setTitle('C3 — Contenedor del participante · PoC RPF Proof Ledger')
    .setDescription(
      [
        'Contenedor del participante, track `C`. Una sola imagen para los 50 tenants:',
        'lo que cambia entre ellos son las variables de entorno, empezando por',
        '`TENANT_ID`.',
        '',
        '### Que hace hoy, tramo por tramo',
        '| | | |',
        '|---|---|---|',
        '| `C-01` | recibe el lote y contesta 202 | ✅ |',
        '| `C-02` | valida el contrato, canoniza (JCS · paso ①) | ✅ |',
        '| `②` | `payload_hash` (SHA-256) · `party_id` (HMAC-SHA256) | ✅ |',
        '| `C-03` | firma Ed25519 | ✅ |',
        '| `C-04` | cifra AES-256-GCM con la llave de C4 | ✅ |',
        '| `C-05` | outbox en la transaccion de negocio | ⛔ pendiente |',
        '| `C-06` | relay a SQS FIFO | ⛔ pendiente |',
        '',
        '⚠ **Mientras C-05 y C-06 no existan, NADA LLEGA A C4.** El sobre se',
        'construye, se mide y se tira. Un 202 con `aceptados: 20` significa que C3 los',
        'firmo y cifro, no que viajaron. `GET /health` lo dice sin rodeos en',
        '`publica_a_sqs`.',
        '',
        '### El orden importa y no se negocia',
        'Se firma primero y se cifra despues (regla 6): la firma cubre el documento, no',
        'un cifrado que cualquiera pudo rehacer. Y **C3 firma y cifra pero no descifra**',
        '— C4 hace lo contrario. Es el invariante del Proof Ledger y vive en las',
        'policies de KMS, no en este codigo.',
        '',
        '### Lo que mide, y por que hay logs en los dos lados',
        'Agrupa por la cabecera `x-prueba-id` y escribe una ventana por minuto en',
        '`c3/logs/<prueba>__<tenant>.json` (recibido), enfrente de',
        '`orquestador/logs/<prueba>.json` (ofrecido). Restarlos es lo que responde P4:',
        'desde un solo lado nunca puedes distinguir «no lo mande» de «lo mande y no',
        'llego».',
        '',
        'Las marcas de tiempo NUNCA van dentro del payload (regla 8): el payload va',
        'firmado, y meterle metadatos de medicion cambiaria lo que se firma.',
      ].join('\n'),
    )
    .setVersion('0.1.0')
    .build();

  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, doc), {
    customSiteTitle: 'C3 — PoC RPF',
    // Igual que el orquestador: la lista plegada y sin reordenar entre recargas,
    // para que el endpoint siga donde lo dejaste a mitad de una corrida.
    swaggerOptions: { defaultModelsExpandDepth: 2, docExpansion: 'list', tryItOutEnabled: true },
  });

  const puerto = Number(process.env.C3_PORT ?? process.env.PORT ?? 3001);
  await app.listen(puerto, '0.0.0.0');
  new Logger('bootstrap').log(`C3 en :${puerto} · Swagger http://localhost:${puerto}/docs`);
}

bootstrap().catch((e) => {
  // Una configuracion mal formada tiene que matar el arranque, no producir un
  // contenedor que firma con la llave equivocada y cuyos numeros no se pueden
  // defender.
  console.error('C3 no pudo arrancar:', e);
  process.exit(1);
});
