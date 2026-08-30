import { Module } from '@nestjs/common';
import { CollectionsController } from './collections.controller';
import { CollectionsService } from './collections.service';
import { CollectionsRepository } from './collections.repository';
import { CoreModule } from '../../../core/core.module';

@Module({
  imports: [CoreModule],
  controllers: [CollectionsController],
  providers: [CollectionsRepository, CollectionsService],
  exports: [CollectionsService],
})
export class CollectionsModule {}
