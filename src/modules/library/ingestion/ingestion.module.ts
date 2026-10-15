import { Module } from '@nestjs/common';
import { CoreModule } from '@/core';
import { SharedKernelModule } from '@/modules/library/shared-kernel/shared-kernel.module';
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

// Gateway Ports & Adapters
import { CATALOG_GATEWAY_PORT } from './types/catalog-gateway.types';
import { InProcessCatalogGatewayAdapter } from './gateways/in-process-catalog-gateway.adapter';
import { HttpCatalogGatewayAdapter } from './gateways/http-catalog-gateway.adapter';
import { EXTRACTION_GATEWAY_PORT } from './types/extraction-gateway.types';
import { InProcessExtractionGatewayAdapter } from './gateways/in-process-extraction-gateway.adapter';
import { HttpExtractionGatewayAdapter } from './gateways/http-extraction-gateway.adapter';

// Facade
import { IngestionFacade, INGESTION_FACADE } from './ingestion.facade';

// Controllers
import {
  IngestionController,
  ProjectIngestionController,
  CurationController,
  RetractionController,
} from './controllers';

// Services
import { IngestionService } from './services/ingestion.service';
import { PipelineService } from './services/pipeline.service';
import { IngestionSagaOrchestrator } from './services/ingestion-saga.orchestrator';
import { QueueService } from './services/queue.service';
import { WatchdogService } from './services/watchdog.service';
import { UrlCaptureService } from './services/url-capture.service';
import { UrlMetadataScraperService } from './services/url-metadata-scraper.service';
import { IngestionQueueConsumer } from './services/ingestion-queue.consumer';
import { ReconciliationService } from './services/metadata-reconciliation.service';
import { ExecutorService } from './services/metadata-executor.service';
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
import { DoiParser, BibtexParser, RisParser, CslParser } from './parsers';
import {
  NormalizationPolicy,
  ReconciliationPolicy,
  DuplicatePolicy,
} from './policies';
import {
  IdentifyStage,
  NormalizeStage,
  EnrichStage,
  ReconcileStage,
  MatchStage,
  CommitStage,
} from './stages';
import {
  UrlCaptureProvider,
  CrossRefProvider,
  ArxivProvider,
  PubMedProvider,
  OpenLibraryProvider,
  OpenAlexProvider,
  UnpaywallProvider,
  RetractionScannerProvider,
  SearxngSearchProvider,
  EuropePmcSearchProvider,
  DblpProvider,
  SemanticScholarProvider,
} from './providers';
import { ExternalSearchComparatorService } from './services/external-search-comparator.service';
import { EXTERNAL_SEARCH_PORT } from './types/external-search.types';
import { RetractionItemEventsSubscriber } from './subscribers/retraction-item-events.subscriber';

const ingestionWorkerProviders = shouldRunWorkerConsumers()
  ? [IngestionQueueConsumer]
  : [];

@Module({
  imports: [
    CoreModule,
    SharedKernelModule,
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

    // Gateway Ports & Adapters
    InProcessCatalogGatewayAdapter,
    HttpCatalogGatewayAdapter,
    {
      provide: CATALOG_GATEWAY_PORT,
      useFactory: (
        inProcess: InProcessCatalogGatewayAdapter,
        http: HttpCatalogGatewayAdapter,
      ) => {
        return process.env.LIBRARY_CATALOG_URL ? http : inProcess;
      },
      inject: [InProcessCatalogGatewayAdapter, HttpCatalogGatewayAdapter],
    },
    InProcessExtractionGatewayAdapter,
    HttpExtractionGatewayAdapter,
    {
      provide: EXTRACTION_GATEWAY_PORT,
      useFactory: (
        inProcess: InProcessExtractionGatewayAdapter,
        http: HttpExtractionGatewayAdapter,
      ) => {
        return process.env.LIBRARY_EXTRACTION_URL ? http : inProcess;
      },
      inject: [InProcessExtractionGatewayAdapter, HttpExtractionGatewayAdapter],
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
    WatchdogService,
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
    ReconciliationService,
    ExecutorService,
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
    {
      provide: EXTERNAL_SEARCH_PORT,
      useExisting: ExternalSearchComparatorService,
    },
  ],
  exports: [
    IngestionFacade,
    INGESTION_FACADE,
    METADATA_PORT,
    IngestionSagaOrchestrator,
    IngestionVerifierService,
    WebFetchLadderService,
    WEB_FETCH_PORT,
    EXTERNAL_SEARCH_PORT,
    ExternalSearchComparatorService,
    SearxngSearchProvider,
    EuropePmcSearchProvider,
    DomainRateLimiterService,
    DblpProvider,
    SemanticScholarProvider,
  ],
})
export class IngestionModule {}
