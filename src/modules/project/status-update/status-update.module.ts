import { Module } from '@nestjs/common';
import { StatusUpdateController } from './status-update.controller';
import { StatusUpdateService } from './status-update.service';
import { StatusUpdateRepository } from './status-update.repository';

@Module({
  controllers: [StatusUpdateController],
  providers: [StatusUpdateService, StatusUpdateRepository],
  exports: [StatusUpdateService, StatusUpdateRepository],
})
export class StatusUpdateModule {}
