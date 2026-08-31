import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { LogsController } from './logs.controller';

/**
 * Va aparte del SaludModule a proposito: aquel reporta el estado del proceso y
 * este sirve archivos de disco. Juntarlos convertiria "lo unico que C4 expone
 * es su salud" en una frase que ya no seria verdad sin que nadie lo notara.
 *
 * ⚠ PLANO, NO EN UNA CARPETA `logs/`. El `.gitignore` de la raiz ignora `logs/`
 * —ahi van las salidas de medicion— y la regla no distingue una carpeta de
 * codigo: `c4/src/logs/` quedaria sin versionar y este modulo se perderia en el
 * primer clon, sin un solo error. C3 pone su controlador igual de plano.
 */
@Module({
  imports: [ConfigModule],
  controllers: [LogsController],
})
export class LogsModule {}
