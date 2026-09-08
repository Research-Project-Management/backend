import { Module } from '@nestjs/common';
import { CycleController } from './cycle.controller';
import { CycleService } from './cycle.service';
import { CycleRepository } from './cycle.repository';

@Module({
  imports: [],
  controllers: [CycleController],
  providers: [CycleService, CycleRepository],
  exports: [CycleService],
})
export class CycleModule {}
