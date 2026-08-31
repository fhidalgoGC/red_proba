import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { ConsumidorModule } from './consumidor/consumidor.module';

@Module({
  imports: [ConfigModule, ConsumidorModule],
})
export class AppModule {}
