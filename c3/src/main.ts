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
        '### El camino esta completo',
        'Un documento que entra por `POST /events` sale por la cola FIFO de C4.',
        'Verificado de punta a punta con KMS, SQS y Postgres reales: **803 ofrecidos →',
        '803 en el outbox → 803 en el inbox de C4 → 0 perdidos.**',
        '',
        '| | | |',
        '|---|---|---|',
        '| `C-01` | recibe el lote y contesta 202 sin esperar al pipeline | ✅ |',
        '| `C-02` | valida el contrato, sustituye `party_id`, canoniza (JCS · paso ①) | ✅ |',
        '| `②` | `payload_hash` (SHA-256) · `party_id` (HMAC-SHA256 de KMS) | ✅ |',
        '| `C-03` | firma Ed25519 | ✅ |',
        '| `C-04` | cifra AES-256-GCM con la llave de C4 | ✅ |',
        '| `C-05` | outbox **dentro** de la transaccion de negocio | ✅ |',
        '| `C-06` | relay a SQS FIFO, con backoff y circuit breaker | ✅ |',
        '| `C-07` | cierre ordenado en SIGTERM | ✅ |',
        '| `C-08` | health que TOCA LA BASE | ✅ |',
        '| `C-09` | marcas `e0..e6` | ✅ |',
        '',
        '### C3 ya no genera documentos',
        'Los construye el orquestador y se los manda hechos: el cuerpo es',
        '`{ lote_id, tenant_id, documentos: [...] }` y C3 arranca en el Canonical',
        'Mapper. `POST /events/generar` **se elimino** — `POST /events` es la unica',
        'entrada.',
        '',
        'Los documentos llegan con **tamaños variados** (`[2048, 4096]` bytes canonicos),',
        'no todos con 3.072. El JCS del orquestador y el de C3 son el MISMO codigo: si',
        'divergieran, el tamaño no cuadraria y la firma no verificaria en C4.',
        '',
        '`party_id` llega como un placeholder de 69 caracteres y C3 lo sustituye por el',
        'HMAC real de KMS antes de canonizar. El largo es fijo para que la sustitucion',
        'no mueva el tamaño que el orquestador ya conto.',
        '',
        '### Un documento malo no tumba al lote',
        'No hay `ValidationPipe`: rechazaria el lote entero con un 400 en cuanto un solo',
        'documento viniera mal. Cada documento se resuelve solo y el 202 trae',
        '`aceptados` y `descartados` por separado — a 2.000 ev/s, un invalido se',
        'llevaria por delante a los otros 19 del lote y la conciliacion de P4 acusaria a',
        'la red.',
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
