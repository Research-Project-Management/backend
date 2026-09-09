import { Module } from '@nestjs/common';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { SearchRepository } from './search.repository';
import { FullTextProvider } from './providers/full-text.provider';
import { RagProvider } from './providers/rag.provider';
import { SearchEventHandler } from './handlers/search-event.handler';
import { CoreModule } from '../../../core/core.module';

@Module({
  imports: [CoreModule],
  controllers: [SearchController],
  providers: [
    SearchRepository,
    SearchService,
    FullTextProvider,
    RagProvider,
    SearchEventHandler,
  ],
  exports: [SearchService, RagProvider],
})
export class SearchModule {}
