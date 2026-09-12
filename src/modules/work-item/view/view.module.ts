import { Module, forwardRef } from '@nestjs/common';
import { ViewController } from './view.controller';
import { ViewService } from './view.service';
import { ViewRepository } from './view.repository';
import { WorkItemCoreModule } from '../core/core.module';

@Module({
  imports: [forwardRef(() => WorkItemCoreModule)],
  controllers: [ViewController],
  providers: [ViewService, ViewRepository],
  exports: [ViewService, ViewRepository],
})
export class ViewModule {}
