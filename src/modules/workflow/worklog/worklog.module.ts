import { Module } from '@nestjs/common';
import { WorklogController } from './worklog.controller';
import { WorklogService } from './worklog.service';
import { WorklogRepository } from './worklog.repository';

@Module({
  controllers: [WorklogController],
  providers: [WorklogService, WorklogRepository],
  exports: [WorklogService, WorklogRepository],
})
export class WorklogModule {}
