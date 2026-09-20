import { Module, forwardRef } from '@nestjs/common';
import { CoreModule } from '../../../core/core.module';
import { CatalogModule } from '../catalog/catalog.module';
import { ContentModule } from '../content/content.module';
import { ProcessingModule } from '../processing/processing.module';

// Facade
import { DiscoveryFacade, DISCOVERY_FACADE } from './discovery.facade';

// ── 1. Search ─────────────────────────────────────────────────────────────
import { SearchController } from './presentation/search.controller';
import { SearchService } from './application/services/search.service';
import { SearchRepository } from './infrastructure/repositories/search.repository';
import { FullTextProvider } from './infrastructure/providers/full-text.provider';
import { RagProvider } from './infrastructure/providers/rag.provider';
import { LocalEmbeddingService } from './application/services/local-embedding.service';
import { VectorIndexService } from './application/services/vector-index.service';
import { SemanticSearchService } from './application/services/semantic-search.service';
import { EventHandler } from './application/handlers/event.handler';

// ── 2. Citation ───────────────────────────────────────────────────────────
import { CitationController } from './presentation/citation.controller';
import { CitationService } from './application/services/citation.service';
import { DoiContentNegotiationService } from './application/services/doi-content-negotiation.service';
import { CslEngineService } from './application/services/csl-engine.service';

// ── 3. Exports ────────────────────────────────────────────────────────────
import { ExportsController } from './presentation/exports.controller';
import { ExportsService } from './application/services/exports.service';
import { PdfBakerService } from './application/services/pdf-baker.service';

// ── Clean Architecture — Ports, Adapters, Use Cases ──────────────────────
import { SEARCH_ENGINE_PORT } from './domain/ports/search-engine.port';
import { CITATION_ENGINE_PORT } from './domain/ports/citation-engine.port';
import { SearchEngineAdapter } from './infrastructure/adapters/search-engine.adapter';
import { CslCitationEngineAdapter } from './infrastructure/adapters/csl-citation-engine.adapter';
import { ExecuteSearchUseCase } from './application/queries/execute-search.use-case';
import { FormatCitationUseCase } from './application/queries/format-citation.use-case';
import { CatalogEventsSubscriber } from './infrastructure/subscribers/catalog-events.subscriber';

/**
 * Discovery Bounded Context Unified Module (Generic Domain).
 *
 * Consolidates all search, citation, and export features into a single Clean Architecture module:
 * - Search (Full-text FTS, Local Semantic Vector Search, Qdrant RAG)
 * - Citation (CSL engine, DOI content negotiation, citation formatting)
 * - Exports (BibTeX, RIS, CSV, JSON, PDF Baker)
 */
@Module({
  imports: [
    CoreModule,
    forwardRef(() => CatalogModule),
    forwardRef(() => ContentModule),
    forwardRef(() => ProcessingModule),
  ],
  controllers: [SearchController, CitationController, ExportsController],
  providers: [
    // Facade
    DiscoveryFacade,
    {
      provide: DISCOVERY_FACADE,
      useExisting: DiscoveryFacade,
    },

    // ── Search Providers ───────────────────────────────────────────────
    SearchRepository,
    SearchService,
    FullTextProvider,
    RagProvider,
    LocalEmbeddingService,
    VectorIndexService,
    SemanticSearchService,
    EventHandler,

    // ── Citation Providers ─────────────────────────────────────────────
    CitationService,
    DoiContentNegotiationService,
    CslEngineService,

    // ── Exports Providers ──────────────────────────────────────────────
    ExportsService,
    PdfBakerService,

    // ── Clean Architecture Ports & Adapters ────────────────────────────
    SearchEngineAdapter,
    {
      provide: SEARCH_ENGINE_PORT,
      useClass: SearchEngineAdapter,
    },
    CslCitationEngineAdapter,
    {
      provide: CITATION_ENGINE_PORT,
      useClass: CslCitationEngineAdapter,
    },
    ExecuteSearchUseCase,
    FormatCitationUseCase,
    CatalogEventsSubscriber,
  ],
  exports: [
    // Facade
    DiscoveryFacade,
    DISCOVERY_FACADE,

    // Clean Architecture Ports
    SEARCH_ENGINE_PORT,
    CITATION_ENGINE_PORT,
  ],

})
export class DiscoveryModule {}
