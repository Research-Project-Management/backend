import { Module } from '@nestjs/common';
import { TagsRepository } from './tags.repository';
import { TagsService } from './tags.service';
import { CoreModule } from '../../../core/core.module';
import { SyncModule } from '../sync/sync.module';

@Module({
  imports: [CoreModule, SyncModule],
  providers: [TagsRepository, TagsService],
  exports: [TagsService],
})
export class TagsModule {}
