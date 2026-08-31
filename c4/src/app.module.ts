import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { ConsumidorModule } from './consumidor/consumidor.module';
import { LogsModule } from './logs.module';
import { MetricasModule } from './metricas/metricas.module';
import { SaludModule } from './salud/salud.module';

@Module({
  // MetricasModule ANTES del consumidor: es @Global y lo inyectan tanto el
  // lazo como el procesador. Y SaludModule ultimo: sus hooks de arranque
  // corren despues de los del consumidor, asi que el puerto no se abre antes
  // de que haya algo que reportar.
  imports: [ConfigModule, MetricasModule, ConsumidorModule, LogsModule, SaludModule],
})
export class AppModule {}
