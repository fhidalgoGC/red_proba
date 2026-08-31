import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module';
import { BdService } from './bd.service';
import { InboxRepository } from './inbox.repository';

@Module({
  imports: [ConfigModule],
  providers: [BdService, InboxRepository],
  exports: [BdService, InboxRepository],
})
export class BdModule {}
