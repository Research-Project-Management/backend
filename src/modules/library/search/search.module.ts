import { Module } from '@nestjs/common';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { SearchRepository } from './search.repository';
import { FullTextProvider } from './providers/full-text.provider';
import { RagProvider } from './providers/rag.provider';
import { LocalEmbeddingService } from './services/local-embedding.service';
import { VectorIndexService } from './services/vector-index.service';
import { SemanticSearchService } from './services/semantic-search.service';
import { EventHandler } from './handlers/event.handler';
import { CoreModule } from '../../../core/core.module';

@Module({
  imports: [CoreModule],
  controllers: [SearchController],
  providers: [
    SearchRepository,
    SearchService,
    FullTextProvider,
    RagProvider,
    LocalEmbeddingService,
    VectorIndexService,
    SemanticSearchService,
    EventHandler,
  ],
  exports: [
    SearchService,
    RagProvider,
    LocalEmbeddingService,
    VectorIndexService,
    SemanticSearchService,
  ],
})
export class SearchModule {}
