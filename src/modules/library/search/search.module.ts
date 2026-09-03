import { Module } from '@nestjs/common';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { SearchRepository } from './search.repository';
import { FullTextIndexer } from './providers/full-text-indexer.provider';
import { SearchEventHandler } from './handlers/search-event.handler';
import { CoreModule } from '../../../core/core.module';

@Module({
  imports: [CoreModule],
  controllers: [SearchController],
  providers: [
    SearchRepository,
    SearchService,
    FullTextIndexer,
    SearchEventHandler,
  ],
  exports: [SearchService],
})
export class SearchModule {}
