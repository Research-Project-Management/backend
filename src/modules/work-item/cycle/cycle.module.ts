import { Module, forwardRef } from '@nestjs/common';
import { CycleController } from './cycle.controller';
import { CycleService } from './cycle.service';
import { CycleRepository } from './cycle.repository';
import { WorkItemModule } from '../work-item.module';

@Module({
  imports: [forwardRef(() => WorkItemModule)],
  controllers: [CycleController],
  providers: [CycleService, CycleRepository],
  exports: [CycleService, CycleRepository],
})
export class CycleModule {}
