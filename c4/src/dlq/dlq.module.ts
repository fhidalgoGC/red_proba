import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module';
import { DlqService } from './dlq.service';

@Module({
  imports: [ConfigModule],
  providers: [DlqService],
  exports: [DlqService],
})
export class DlqModule {}
