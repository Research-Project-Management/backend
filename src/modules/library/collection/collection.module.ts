import { Module } from '@nestjs/common';
import { CollectionController } from './collection.controller';
import { CollectionService } from './collection.service';
import { CollectionRepository } from './collection.repository';
import { BibtexFormatter } from '../reference/formatters/bibtex.formatter';

@Module({
  controllers: [CollectionController],
  providers: [CollectionService, CollectionRepository, BibtexFormatter],
  exports: [CollectionService, CollectionRepository, BibtexFormatter],
})
export class CollectionModule {}

