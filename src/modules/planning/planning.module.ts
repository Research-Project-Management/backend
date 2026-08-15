import { Module } from '@nestjs/common';
import { TaskModule } from './task/task.module';
import { CycleModule } from './cycle/cycle.module';

@Module({
  imports: [TaskModule, CycleModule],
  exports: [TaskModule, CycleModule],
})
export class PlanningModule {}
