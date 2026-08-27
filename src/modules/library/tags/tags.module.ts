import { Module } from '@nestjs/common';
import { TagsRepository } from './tags.repository';
import { TagsService } from './tags.service';
import { CoreModule } from '../../../core/core.module';
import { SyncCoreContextModule } from '../sync-core/sync-core.module';

@Module({
  imports: [CoreModule, SyncCoreContextModule],
  providers: [TagsRepository, TagsService],
  exports: [TagsRepository, TagsService],
})
export class TagsContextModule {}
