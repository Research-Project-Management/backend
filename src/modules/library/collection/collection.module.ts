import { Module } from '@nestjs/common';
import { CollectionController } from './collection.controller';
import { CollectionService } from './collection.service';
import { CollectionRepository } from './collection.repository';

@Module({
  controllers: [CollectionController],
  providers: [CollectionService, CollectionRepository],
  exports: [CollectionService, CollectionRepository],
})
export class CollectionModule {}
