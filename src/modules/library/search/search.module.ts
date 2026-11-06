import { Global, Module } from '@nestjs/common';
import { CoreModule } from '@/core';

// Presentation
import { SearchController } from './controllers/search.controller';

// Services, Facade & Infrastructure
import {
  SearchFacade,
  SEARCH_FACADE,
  SearchService,
  FullTextProvider,
  SearchEventsSubscriber,
} from './services/search.service';
import { SearchRepository } from './repositories/search.repository';

/**
 * Search Bounded Context Unified Module (Generic Domain).
 *
 * Dedicated strictly to Information Retrieval:
 * - Full-text FTS (Postgres tsvector with language weights)
 * - Faceted search & anchor matching
 * - Event-driven search index updates
 */
@Global()
@Module({
  imports: [CoreModule],
  controllers: [SearchController],
  providers: [
    SearchFacade,
    {
      provide: SEARCH_FACADE,
      useExisting: SearchFacade,
    },
    SearchRepository,
    SearchService,
    FullTextProvider,
    SearchEventsSubscriber,
  ],
  exports: [SEARCH_FACADE, SearchFacade],
})
export class SearchModule {}
