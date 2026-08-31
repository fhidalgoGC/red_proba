import { Module } from '@nestjs/common';
import { ManifiestoService } from './manifiesto.service';
import { MetricasService } from './metricas.service';
import { RegistroService } from './registro.service';

@Module({
  providers: [ManifiestoService, MetricasService, RegistroService],
  exports: [ManifiestoService, MetricasService, RegistroService],
})
export class MetricasModule {}
