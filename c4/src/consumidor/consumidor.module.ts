import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module';
import { BdModule } from '../bd/bd.module';
import { CriptoModule } from '../cripto/cripto.module';
import { DlqModule } from '../dlq/dlq.module';
import { ConsumidorService } from './consumidor.service';
import { ProcesadorService } from './procesador.service';

@Module({
  imports: [ConfigModule, BdModule, CriptoModule, DlqModule],
  providers: [ConsumidorService, ProcesadorService],
  exports: [ConsumidorService, ProcesadorService],
})
export class ConsumidorModule {}
