import { Module } from '@nestjs/common';
import { CoreModule } from '../../../core/core.module';
import { SearchFacade, SEARCH_FACADE } from './search.facade';

// Presentation
import { SearchController } from './presentation/search.controller';

// Application
import { SearchService } from './application/services/search.service';
import { SearchRepository } from './infrastructure/repositories/search.repository';
import { FullTextProvider } from './infrastructure/providers/full-text.provider';
import { EventHandler } from './application/handlers/event.handler';
import { ExecuteSearchUseCase } from './application/queries/execute-search.use-case';
import { SearchEngineAdapter } from './infrastructure/adapters/search-engine.adapter';
import { SEARCH_ENGINE_PORT } from './domain/ports/search-engine.port';
import { CatalogEventsSubscriber } from './infrastructure/subscribers/catalog-events.subscriber';

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
    SearchEngineAdapter,
    {
      provide: SEARCH_ENGINE_PORT,
      useClass: SearchEngineAdapter,
    },
    ExecuteSearchUseCase,
    CatalogEventsSubscriber,
  ],
  exports: [
    SearchFacade,
    SEARCH_FACADE,
    SearchService,
    SEARCH_ENGINE_PORT,
  ],
})
export class SearchModule {}
