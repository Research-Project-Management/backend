import { Module } from '@nestjs/common';
import { PrismaModule } from '@/core';
import { CoreModule } from '../core/core.module';
import { DraftController } from './draft.controller';
import { DraftRepository } from './draft.repository';
import { DraftService } from './draft.service';

@Module({
  imports: [PrismaModule, CoreModule],
  controllers: [DraftController],
  providers: [DraftRepository, DraftService],
  exports: [DraftService, DraftRepository],
})
export class DraftModule {}
