import { Module } from '@nestjs/common';
import { EmisorService } from './emisor.service';
import { MetricasModule } from '../metricas/metricas.module';

@Module({
  imports: [MetricasModule],
  providers: [EmisorService],
  exports: [EmisorService],
})
export class EmisorModule {}
