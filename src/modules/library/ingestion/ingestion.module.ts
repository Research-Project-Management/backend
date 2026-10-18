import { Module } from '@nestjs/common';
import { CoreModule } from '@/core';
import { LibraryCoreModule } from '@/modules/library/core/core.module';
import { StorageModule } from '@/modules/storage/storage.module';
import { CatalogModule } from '@/modules/library/catalog/catalog.module';
import { ExtractionModule } from '@/modules/library/extraction/extraction.module';
import { BullModule } from '@nestjs/bullmq';
import {
  LIBRARY_INGESTION_QUEUE_PRIORITY,
  LIBRARY_INGESTION_QUEUE_STANDARD,
  LIBRARY_INGESTION_QUEUE_CAPTURE,
} from './types/queue.constants';
import { shouldRunWorkerConsumers } from '@/core';

// Facade
import { IngestionFacade, INGESTION_FACADE } from './ingestion.facade';

// Controllers
import {
  IngestionController,
  ProjectIngestionController,
} from './controllers/ingestion.controller';
import { CurationController } from './controllers/curation.controller';
import { RetractionController } from './controllers/retraction.controller';

// Services
import { IngestionService } from './services/ingestion.service';
import { PipelineService } from './services/pipeline.service';
import { IngestionSagaOrchestrator } from './services/ingestion-saga.orchestrator';
import { QueueService } from './services/queue.service';
import { UrlCaptureService } from './services/url-capture.service';
import { UrlMetadataScraperService } from './services/url-metadata-scraper.service';
import { IngestionQueueConsumer } from './services/ingestion-queue.consumer';
import { MetadataReconciliationService } from './services/metadata-reconciliation.service';
import { MetadataExecutorService } from './services/metadata-executor.service';
import { MetadataService } from './services/metadata.service';
import { DuplicateService } from './services/duplicate.service';
import { QualityService } from './services/quality.service';
import { RetractionService } from './services/retraction.service';
import { RetractionDatabaseService } from './services/retraction-database.service';
import { RetractionSyncService } from './services/retraction-sync.service';
import { IngestionVerifierService } from './services/ingestion-verifier.service';
import { WebFetchLadderService } from './services/web-fetch-ladder.service';
import { DomainRateLimiterService } from './services/domain-rate-limiter.service';
import { WEB_FETCH_PORT } from './types/web-fetch.types';

// Repositories
import { IngestionRepository } from './repositories/ingestion.repository';
import { IdempotencyRepository } from './repositories/idempotency.repository';
import { MetadataCache } from './repositories/metadata.cache';
import { RetractionRepository } from './repositories/retraction.repository';

// Types & Ports
import {
  METADATA_PROVIDERS,
  METADATA_PORT,
  MetadataProvider,
} from './types/metadata.types';

// Parsers & Policies & Stages & Providers
import { DoiParser } from './parsers/doi.parser';
import { BibtexParser } from './parsers/bibtex.parser';
import { RisParser } from './parsers/ris.parser';
import { CslParser } from './parsers/csl.parser';
import { NormalizationPolicy } from './policies/normalization.policy';
import { ReconciliationPolicy } from './policies/reconciliation.policy';
import { DuplicatePolicy } from './policies/duplicate.policy';
import { IdentifyStage } from './stages/identify.stage';
import { NormalizeStage } from './stages/normalize.stage';
import { EnrichStage } from './stages/enrich.stage';
import { ReconcileStage } from './stages/reconcile.stage';
import { MatchStage } from './stages/match.stage';
import { CommitStage } from './stages/commit.stage';
import { UrlCaptureProvider } from './providers/url-capture.provider';
import { CrossRefProvider } from './providers/crossref.provider';
import { ArxivProvider } from './providers/arxiv.provider';
import { PubMedProvider } from './providers/pubmed.provider';
import { OpenLibraryProvider } from './providers/openlibrary.provider';
import { OpenAlexProvider } from './providers/openalex.provider';
import { UnpaywallProvider } from './providers/unpaywall.provider';
import { RetractionScannerProvider } from './providers/retraction-scanner.provider';
import { SearxngSearchProvider } from './providers/searxng.provider';
import { EuropePmcSearchProvider } from './providers/europe-pmc-search.provider';
import { DblpProvider } from './providers/dblp.provider';
import { SemanticScholarProvider } from './providers/semantic-scholar.provider';
import { ExternalSearchComparatorService } from './services/external-search-comparator.service';
import { RetractionItemEventsSubscriber } from './subscribers/retraction-item-events.subscriber';

const ingestionWorkerProviders = shouldRunWorkerConsumers()
  ? [IngestionQueueConsumer]
  : [];

@Module({
  imports: [
    CoreModule,
    LibraryCoreModule,
    StorageModule,
    CatalogModule,
    ExtractionModule,
    BullModule.registerQueue(
      { name: LIBRARY_INGESTION_QUEUE_PRIORITY },
      { name: LIBRARY_INGESTION_QUEUE_STANDARD },
      { name: LIBRARY_INGESTION_QUEUE_CAPTURE },
    ),
  ],
  controllers: [
    IngestionController,
    ProjectIngestionController,
    CurationController,
    RetractionController,
  ],
  providers: [
    // Facade
    IngestionFacade,
    {
      provide: INGESTION_FACADE,
      useExisting: IngestionFacade,
    },

    // Repositories
    IngestionRepository,
    IdempotencyRepository,
    MetadataCache,
    RetractionRepository,

    // Services
    IngestionService,
    PipelineService,
    IngestionSagaOrchestrator,
    QueueService,
    UrlCaptureService,
    UrlMetadataScraperService,
    IngestionVerifierService,
    WebFetchLadderService,
    {
      provide: WEB_FETCH_PORT,
      useClass: WebFetchLadderService,
    },
    ...ingestionWorkerProviders,

    // Parsers & Policies & Stages
    DoiParser,
    BibtexParser,
    RisParser,
    CslParser,
    { provide: NormalizationPolicy, useClass: NormalizationPolicy },
    { provide: ReconciliationPolicy, useClass: ReconciliationPolicy },
    { provide: DuplicatePolicy, useClass: DuplicatePolicy },
    IdentifyStage,
    NormalizeStage,
    EnrichStage,
    ReconcileStage,
    MatchStage,
    CommitStage,
    UrlCaptureProvider,

    // Metadata Providers & Enrichment
    DomainRateLimiterService,
    MetadataReconciliationService,
    MetadataExecutorService,
    CrossRefProvider,
    ArxivProvider,
    PubMedProvider,
    OpenLibraryProvider,
    OpenAlexProvider,
    UnpaywallProvider,
    DblpProvider,
    SemanticScholarProvider,
    {
      provide: METADATA_PROVIDERS,
      useFactory: (
        crossref: CrossRefProvider,
        arxiv: ArxivProvider,
        pubmed: PubMedProvider,
        openlibrary: OpenLibraryProvider,
        openalex: OpenAlexProvider,
        unpaywall: UnpaywallProvider,
        dblp: DblpProvider,
        semanticscholar: SemanticScholarProvider,
      ): MetadataProvider[] => [
        crossref,
        arxiv,
        pubmed,
        openlibrary,
        openalex,
        unpaywall,
        dblp,
        semanticscholar,
      ],
      inject: [
        CrossRefProvider,
        ArxivProvider,
        PubMedProvider,
        OpenLibraryProvider,
        OpenAlexProvider,
        UnpaywallProvider,
        DblpProvider,
        SemanticScholarProvider,
      ],
    },
    MetadataService,
    {
      provide: METADATA_PORT,
      useExisting: MetadataService,
    },

    // Curation
    DuplicateService,
    QualityService,

    // Retraction Watch
    RetractionService,
    RetractionDatabaseService,
    RetractionScannerProvider,
    RetractionSyncService,
    RetractionItemEventsSubscriber,

    // External Search Providers & Benchmark Comparator
    SearxngSearchProvider,
    EuropePmcSearchProvider,
    ExternalSearchComparatorService,
  ],
  exports: [
    IngestionFacade,
    INGESTION_FACADE,
    METADATA_PORT,
    IngestionSagaOrchestrator,
    IngestionVerifierService,
    WebFetchLadderService,
    WEB_FETCH_PORT,
    ExternalSearchComparatorService,
    SearxngSearchProvider,
    EuropePmcSearchProvider,
    DomainRateLimiterService,
    DblpProvider,
    SemanticScholarProvider,
  ],
})
export class IngestionModule {}
