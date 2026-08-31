import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { ConsumidorModule } from './consumidor/consumidor.module';
import { SaludModule } from './salud/salud.module';

@Module({
  // SaludModule va ultimo: sus hooks de arranque corren despues de los del
  // consumidor, asi que el puerto no se abre antes de que haya algo que
  // reportar.
  imports: [ConfigModule, ConsumidorModule, SaludModule],
})
export class AppModule {}
