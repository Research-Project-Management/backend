import { Module } from '@nestjs/common';
import { CoreModule } from '../../../core/core.module';
import { SearchFacade, SEARCH_FACADE } from './search.facade';

// Presentation
import { SearchController } from './controllers';

// Services & Infrastructure
import { SearchService } from './services/search.service';
import { SearchRepository } from './repositories/search.repository';
import { FullTextProvider } from './services/full-text.provider';
import { EventHandler } from './services/event.handler';
import { PostgresFtsAdapter } from './services/search-engine.adapter';
import { VectorSearchAdapter } from './services/vector-search.adapter';
import {
  SEARCH_ENGINE_PORT,
  VECTOR_SEARCH_ENGINE_PORT,
} from './types/search-engine.types';
import { CatalogEventsSubscriber } from './services/catalog-events.subscriber';

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
    EventHandler,
    PostgresFtsAdapter,
    {
      provide: SEARCH_ENGINE_PORT,
      useClass: PostgresFtsAdapter,
    },
    VectorSearchAdapter,
    {
      provide: VECTOR_SEARCH_ENGINE_PORT,
      useClass: VectorSearchAdapter,
    },
    CatalogEventsSubscriber,
  ],
  exports: [
    SearchFacade,
    SEARCH_FACADE,
    SearchService,
    SEARCH_ENGINE_PORT,
    VectorSearchAdapter,
    VECTOR_SEARCH_ENGINE_PORT,
  ],
})
export class SearchModule {}
