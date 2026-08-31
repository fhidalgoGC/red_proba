import { Module } from '@nestjs/common';
import { PlanificadorService } from './planificador.service';
import { GeneradorModule } from '../generador/generador.module';
import { EmisorModule } from '../emisor/emisor.module';
import { MetricasModule } from '../metricas/metricas.module';

@Module({
  imports: [GeneradorModule, EmisorModule, MetricasModule],
  providers: [PlanificadorService],
  exports: [PlanificadorService],
})
export class PlanificadorModule {}
