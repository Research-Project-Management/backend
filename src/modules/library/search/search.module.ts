import { Module } from '@nestjs/common';
import { CoreModule } from '@/core';
import { SearchFacade, SEARCH_FACADE } from './search.facade';

// Presentation
import { SearchController } from './controllers/search.controller';

// Services & Infrastructure
import { SearchService } from './services/search.service';
import { SearchRepository } from './repositories/search.repository';
import { FullTextProvider } from './services/full-text.provider';
import { SearchEventsSubscriber } from './subscribers/search-events.subscriber';

/**
 * Search Bounded Context Unified Module (Generic Domain).
 *
 * Dedicated strictly to Information Retrieval:
 * - Full-text FTS (Postgres tsvector with language weights)
 * - Faceted search & anchor matching
 * - Event-driven search index updates
 */
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
