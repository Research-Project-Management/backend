import { Module } from '@nestjs/common';
import { CoreModule } from '../../../core/core.module';
import { SharedKernelModule } from '../shared-kernel/shared-kernel.module';
import { StorageModule } from '../../storage/storage.module';
import { BullModule } from '@nestjs/bullmq';
import {
  LIBRARY_INGESTION_QUEUE_PRIORITY,
  LIBRARY_INGESTION_QUEUE_STANDARD,
  LIBRARY_INGESTION_QUEUE_CAPTURE,
} from './types/queue.constants';
import { shouldRunWorkerConsumers } from '../../../core/utils/worker-mode.util';

// Gateway Ports & Adapters
import { CATALOG_GATEWAY_PORT } from './types/catalog-gateway.types';
import { InProcessCatalogGatewayAdapter } from './utils/in-process-catalog-gateway.adapter';
import { HttpCatalogGatewayAdapter } from './utils/http-catalog-gateway.adapter';
import { EXTRACTION_GATEWAY_PORT } from './types/extraction-gateway.types';
import { InProcessExtractionGatewayAdapter } from './utils/in-process-extraction-gateway.adapter';
import { HttpExtractionGatewayAdapter } from './utils/http-extraction-gateway.adapter';

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

// Repositories
import { IngestionRepository } from './repositories/ingestion.repository';
import { IdempotencyRepository } from './repositories/idempotency.repository';
import { MetadataCache } from './repositories/metadata.cache';
import { RetractionRepository } from './repositories/retraction.repository';
import { PrismaIngestionRunRepositoryAdapter } from './repositories/prisma-ingestion-run-repository.adapter';

// Types & Ports
import { INGESTION_PORT } from './types/ingestion.types';
import { INGESTION_RUN_REPOSITORY_PORT } from './types/ingestion-run-repository.types';
import {
  METADATA_PROVIDERS,
  METADATA_PORT,
  MetadataProvider,
} from './types/metadata.types';

// Parsers & Policies & Stages & Providers
import { DoiParser, BibtexParser, RisParser } from './parsers';
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
} from './providers';
import { RetractionItemEventsSubscriber } from './utils/retraction-item-events.subscriber';

const ingestionWorkerProviders = shouldRunWorkerConsumers()
  ? [IngestionQueueConsumer]
  : [];

@Module({
  imports: [
    CoreModule,
    SharedKernelModule,
    StorageModule,
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
    PrismaIngestionRunRepositoryAdapter,
    {
      provide: INGESTION_RUN_REPOSITORY_PORT,
      useClass: PrismaIngestionRunRepositoryAdapter,
    },

    // Services
    IngestionService,
    {
      provide: INGESTION_PORT,
      useExisting: IngestionService,
    },
    PipelineService,
    IngestionSagaOrchestrator,
    QueueService,
    WatchdogService,
    UrlCaptureService,
    UrlMetadataScraperService,
    ...ingestionWorkerProviders,

    // Parsers & Policies & Stages
    DoiParser,
    BibtexParser,
    RisParser,
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
    ReconciliationService,
    ExecutorService,
    CrossRefProvider,
    ArxivProvider,
    PubMedProvider,
    OpenLibraryProvider,
    OpenAlexProvider,
    UnpaywallProvider,
    {
      provide: METADATA_PROVIDERS,
      useFactory: (
        crossref: CrossRefProvider,
        arxiv: ArxivProvider,
        pubmed: PubMedProvider,
        openlibrary: OpenLibraryProvider,
        openalex: OpenAlexProvider,
        unpaywall: UnpaywallProvider,
      ): MetadataProvider[] => [
        crossref,
        arxiv,
        pubmed,
        openlibrary,
        openalex,
        unpaywall,
      ],
      inject: [
        CrossRefProvider,
        ArxivProvider,
        PubMedProvider,
        OpenLibraryProvider,
        OpenAlexProvider,
        UnpaywallProvider,
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
  ],
  exports: [
    IngestionFacade,
    INGESTION_FACADE,
    INGESTION_RUN_REPOSITORY_PORT,
    INGESTION_PORT,
    METADATA_PORT,
    CATALOG_GATEWAY_PORT,
    EXTRACTION_GATEWAY_PORT,
    IngestionSagaOrchestrator,
  ],
})
export class IngestionModule {}
