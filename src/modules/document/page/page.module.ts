import { Module } from '@nestjs/common';
import { CoreModule } from '../core/core.module';
import { PageController } from '../core/core.controller';
import { PageService } from '../core/core.service';
import { PageRepository } from '../core/core.repository';

@Module({
  imports: [CoreModule],
  exports: [CoreModule],
})
export class PageModule {}

export { PageController, PageService, PageRepository };
