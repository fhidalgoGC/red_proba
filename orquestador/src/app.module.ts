import { Logger, Module, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { CorridaModule } from './corrida/corrida.module';
import { BatchController } from './corrida/batch.controller';
import { EmisorModule } from './emisor/emisor.module';
import { GeneradorModule } from './generador/generador.module';
import { MetricasModule } from './metricas/metricas.module';
import { StatusController } from './metricas/status.controller';
import { PlanificadorModule } from './planificador/planificador.module';

@Module({
  imports: [ConfigModule, CorridaModule, GeneradorModule, MetricasModule, EmisorModule, PlanificadorModule],
  controllers: [StatusController, BatchController],
})
export class AppModule implements OnApplicationBootstrap {
  private readonly logger = new Logger(AppModule.name);

  onApplicationBootstrap(): void {
    // El contenedor arranca VACIO y espera. Antes autoarrancaba una corrida
    // con el perfil del YAML; ahora las corridas se piden por HTTP, asi que
    // arrancar sola convertiria cada despliegue en una prueba no pedida cuyos
    // numeros se mezclarian con la siguiente.
    this.logger.log('listo · POST /batch lanza · GET /batch/:id consulta');
  }
}
