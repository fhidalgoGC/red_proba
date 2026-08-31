import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module';
import { MetricasService } from './metricas.service';
import { RegistroService } from './registro.service';

/**
 * G-11 · el reloj de C4.
 *
 * `@Global` porque lo instrumentan cuatro capas —el lazo, el procesador, el
 * cripto y el repositorio— y ninguna de ellas se importa entre si. La
 * alternativa era anadir `MetricasModule` a los imports de cada modulo y
 * acordarse de hacerlo la proxima vez que se anada uno: un tramo sin medir no
 * rompe nada, simplemente desaparece del informe.
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [MetricasService, RegistroService],
  exports: [MetricasService, RegistroService],
})
export class MetricasModule {}
