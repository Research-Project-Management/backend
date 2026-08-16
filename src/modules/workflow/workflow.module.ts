import { Module } from '@nestjs/common';
import { TaskModule } from './task/task.module';
import { CycleModule } from './cycle/cycle.module';
import { WorklogModule } from './worklog/worklog.module';

@Module({
  imports: [TaskModule, CycleModule, WorklogModule],
  exports: [TaskModule, CycleModule, WorklogModule],
})
export class WorkflowModule {}
