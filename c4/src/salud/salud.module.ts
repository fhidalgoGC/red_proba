import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module';
import { BdModule } from '../bd/bd.module';
import { ConsumidorModule } from '../consumidor/consumidor.module';
import { SaludController } from './salud.controller';
import { SaludService } from './salud.service';

@Module({
  imports: [ConfigModule, BdModule, ConsumidorModule],
  controllers: [SaludController],
  providers: [SaludService],
  exports: [SaludService],
})
export class SaludModule {}
