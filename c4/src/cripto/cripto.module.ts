import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module';
import { DescifradorService } from './descifrador.service';
import { VerificadorService } from './verificador.service';

@Module({
  imports: [ConfigModule],
  providers: [DescifradorService, VerificadorService],
  exports: [DescifradorService, VerificadorService],
})
export class CriptoModule {}
