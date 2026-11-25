/**
 * modules/bff/web/web-bff.module.ts
 * Web-channel Thin BFF module composing domain modules strictly one-way.
 */

import { Module } from '@nestjs/common';
import { ProjectModule } from '@/modules/project/project.module';
import { ChatModule } from '@/modules/chat/chat.module';
import { PagesModule } from '@/modules/pages/pages.module';
import { BffCoreModule } from '../core/bff-core.module';
import { WebBffController } from './web-bff.controller';
import { WebBffService } from './web-bff.service';

@Module({
  imports: [BffCoreModule, ProjectModule, ChatModule, PagesModule],
  controllers: [WebBffController],
  providers: [WebBffService],
  exports: [WebBffService],
})
export class WebBffModule {}
