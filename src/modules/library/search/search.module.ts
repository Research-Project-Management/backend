import { Module } from '@nestjs/common';
import { CoreModule } from '../../../core/core.module';
import { SearchFacade, SEARCH_FACADE } from './search.facade';

// Presentation
import { SearchController } from './search.controller';

// Application & Infrastructure (Hexagonal)
import { SearchService } from './core/use-cases/search.service';
import { SearchRepository } from './core/adapters/search.repository';
import { FullTextProvider } from './core/adapters/full-text.provider';
import { EventHandler } from './core/adapters/event.handler';
import { ExecuteSearchUseCase } from './core/use-cases/execute-search.use-case';
import { PostgresFtsAdapter } from './core/adapters/search-engine.adapter';
import { VectorSearchAdapter } from './core/adapters/vector-search.adapter';
import {
  SEARCH_ENGINE_PORT,
  VECTOR_SEARCH_ENGINE_PORT,
} from './core/ports/search-engine.port';
import { CatalogEventsSubscriber } from './core/adapters/catalog-events.subscriber';

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
    ExecuteSearchUseCase,
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
