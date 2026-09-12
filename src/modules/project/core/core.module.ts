import { Module } from '@nestjs/common';
import { CoreController } from './core.controller';
import { CoreService } from './core.service';
import { CoreRepository } from './core.repository';

@Module({
  controllers: [CoreController],
  providers: [CoreService, CoreRepository],
  exports: [CoreService, CoreRepository],
})
export class CoreModule {}
