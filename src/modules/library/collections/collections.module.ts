import { Module } from '@nestjs/common';
import { CollectionsController } from './collections.controller';
import { CollectionsService } from './collections.service';
import { CollectionsRepository } from './collections.repository';
import { TreeEngine } from './engines/tree.engine';
import { CoreModule } from '../../../core/core.module';

@Module({
  imports: [CoreModule],
  controllers: [CollectionsController],
  providers: [CollectionsRepository, CollectionsService, TreeEngine],
  exports: [CollectionsService, TreeEngine],
})
export class CollectionsModule {}
