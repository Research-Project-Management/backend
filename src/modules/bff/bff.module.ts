/**
 * modules/bff/bff.module.ts
 * Single flat BFF module composing domain modules strictly 1-way.
 */

import { Module } from '@nestjs/common';
import { ProjectModule } from '@/modules/project/project.module';
import { ChatModule } from '@/modules/project/chat/chat.module';
import { PagesModule } from '@/modules/pages/pages.module';
import { BffCacheService } from './bff.cache';
import { BffController } from './bff.controller';
import { BffService } from './bff.service';

@Module({
  imports: [ProjectModule, ChatModule, PagesModule],
  controllers: [BffController],
  providers: [BffCacheService, BffService],
})
export class BffModule {}
