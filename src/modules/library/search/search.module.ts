import { Module } from '@nestjs/common';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { SearchRepository } from './search.repository';
import { FullTextIndexer } from './providers/full-text-indexer.provider';
import { CoreModule } from '../../../core/core.module';

@Module({
  imports: [CoreModule],
  controllers: [SearchController],
  providers: [SearchRepository, SearchService, FullTextIndexer],
  exports: [SearchRepository, SearchService, FullTextIndexer],
})
export class SearchModule {}
