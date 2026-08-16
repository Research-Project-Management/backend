import { Module, forwardRef } from '@nestjs/common';
import { CycleController } from './cycle.controller';
import { CycleService } from './cycle.service';
import { CycleRepository } from './cycle.repository';
import { TaskModule } from '../task/task.module';

@Module({
  imports: [forwardRef(() => TaskModule)],
  controllers: [CycleController],
  providers: [CycleService, CycleRepository],
  exports: [CycleService, CycleRepository],
})
export class CycleModule {}
