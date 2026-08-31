import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { BdService } from './bd/bd.service';
import { OutboxRepository } from './bd/outbox.repository';
import { ConfigService } from './config/config.service';
import { CifradorService } from './cripto/cifrador.service';
import { FirmadorService } from './cripto/firmador.service';
import { PseudonimoService } from './cripto/pseudonimo.service';
import { EventosController } from './eventos.controller';
import { ObservabilidadController } from './observabilidad.controller';
import { MapperService } from './mapper/mapper.service';
import { PipelineService } from './pipeline/pipeline.service';
import { PublicadorService } from './relay/publicador.service';
import { RelayService } from './relay/relay.service';
import { RegistroService } from './registro.service';

@Module({
  // El relay vive en el MISMO proceso que el API (D-07): un @Interval, no un
  // contenedor aparte.
  imports: [ScheduleModule.forRoot()],
  controllers: [EventosController, ObservabilidadController],
  providers: [
    ConfigService,
    BdService,
    OutboxRepository,
    RegistroService,
    // Con factory: el constructor del mapper toma el rango de bytes como
    // parametros para que los tests puedan apretarlo, y Nest no sabe inyectar
    // un `number`. La factory usa los defaults, que salen del entorno.
    { provide: MapperService, useFactory: () => new MapperService() },
    PseudonimoService,
    FirmadorService,
    CifradorService,
    PipelineService,
    PublicadorService,
    RelayService,
  ],
})
export class AppModule {}
