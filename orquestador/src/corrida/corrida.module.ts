import { Global, Module } from '@nestjs/common';
import { CorridaService } from './corrida.service';

/**
 * Global porque el planificador y el emisor leen la corrida activa, y hacerla
 * global evita tener que importar este modulo en cada uno de ellos.
 */
@Global()
@Module({
  providers: [CorridaService],
  exports: [CorridaService],
})
export class CorridaModule {}
