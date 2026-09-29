import { Module } from '@nestjs/common';
import { CoreModule } from '../../../core/core.module';
import { SharedKernelModule } from '../shared-kernel/shared-kernel.module';
import { CatalogModule } from '../catalog/catalog.module';
import { ExtractionModule } from '../extraction/extraction.module';
import { StorageModule } from '../../storage/storage.module';
import { SyncModule } from '../sync/sync.module';
import { BullModule } from '@nestjs/bullmq';
import {
  LIBRARY_INGESTION_QUEUE,
  LIBRARY_INGESTION_QUEUE_PRIORITY,
  LIBRARY_INGESTION_QUEUE_STANDARD,
  LIBRARY_INGESTION_QUEUE_CAPTURE,
} from './core/domain/queue.constants';
import { shouldRunWorkerConsumers } from '../../../core/utils/worker-mode.util';

// Gateway Ports & Adapters for Microservice Decoupling
import { CATALOG_GATEWAY_PORT } from './core/ports/catalog-gateway.port';
import { InProcessCatalogGatewayAdapter } from './core/adapters/in-process-catalog-gateway.adapter';
import { EXTRACTION_GATEWAY_PORT } from './core/ports/extraction-gateway.port';
import { InProcessExtractionGatewayAdapter } from './core/adapters/in-process-extraction-gateway.adapter';

// Facade
import {
  IngestionFacade,
  INGESTION_FACADE,
  ProcessingFacade,
  PROCESSING_FACADE,
} from './ingestion.facade';

// ── 1. Ingestion Pipeline ─────────────────────────────────────────────────
import { IngestionController } from './ingestion.controller';
import { IngestionService } from './core/use-cases/ingestion.service';
import { IngestionRepository } from './core/adapters/ingestion.repository';
import { IdempotencyRepository } from './core/adapters/idempotency.repository';
import { DoiParser } from './core/adapters/doi.parser';
import { BibtexParser } from './core/adapters/bibtex.parser';
import { RisParser } from './core/adapters/ris.parser';
import { NormalizationPolicy } from './core/domain/normalization.policy';
import { ReconciliationPolicy } from './core/domain/reconciliation.policy';
import { DuplicatePolicy } from './core/domain/duplicate.policy';
import { IdentifyStage } from './core/adapters/identify.stage';
import { NormalizeStage } from './core/adapters/normalize.stage';
import { EnrichStage } from './core/adapters/enrich.stage';
import { ReconcileStage } from './core/adapters/reconcile.stage';
import { MatchStage } from './core/adapters/match.stage';
import { CommitStage } from './core/adapters/commit.stage';
import { UrlCaptureProvider } from './core/adapters/url-capture.provider';
import { INGESTION_PORT } from './core/domain/ingestion.types';
import { WatchdogService } from './core/use-cases/watchdog.service';
import { UrlCaptureService } from './core/use-cases/url-capture.service';
import { PipelineService } from './core/use-cases/pipeline.service';
import { IngestionSagaOrchestrator } from './core/use-cases/ingestion-saga.orchestrator';
import { QueueService } from './core/use-cases/queue.service';
import { IngestionQueueConsumer } from './core/use-cases/ingestion-queue.consumer';
import { UrlMetadataScraperService } from './core/use-cases/url-metadata-scraper.service';

// ── 2. Metadata Resolution ────────────────────────────────────────────────
import {
  METADATA_PROVIDERS,
  METADATA_PORT,
  MetadataProvider,
} from './core/domain/metadata.types';
import { MetadataCache } from './core/adapters/metadata.cache';
import { ReconciliationService } from './core/use-cases/metadata-reconciliation.service';
import { ExecutorService } from './core/use-cases/metadata-executor.service';
import { MetadataService } from './core/use-cases/metadata.service';
import { CrossRefProvider } from './core/adapters/crossref.provider';
import { ArxivProvider } from './core/adapters/arxiv.provider';
import { PubMedProvider } from './core/adapters/pubmed.provider';
import { OpenLibraryProvider } from './core/adapters/openlibrary.provider';
import { OpenAlexProvider } from './core/adapters/openalex.provider';
import { UnpaywallProvider } from './core/adapters/unpaywall.provider';

// ── 3. Curation / Deduplication ──────────────────────────────────────────
import { CurationController } from './curation.controller';
import { DuplicateService } from './core/use-cases/duplicate.service';
import { QualityService } from './core/use-cases/quality.service';

// ── 4. Retraction Watch ──────────────────────────────────────────────────
import { RetractionController } from './retraction.controller';
import { RetractionService } from './core/use-cases/retraction.service';
import { RetractionRepository } from './core/adapters/retraction.repository';
import { RetractionScannerProvider } from './core/adapters/retraction-scanner.provider';
import { RetractionDatabaseService } from './core/use-cases/retraction-database.service';
import { RetractionSyncService } from './core/use-cases/retraction-sync.service';

// ── Clean Architecture — Ingestion Run Port & Use Cases ──────────────────
import { INGESTION_RUN_REPOSITORY_PORT } from './core/ports/ingestion-run-repository.port';
import { PrismaIngestionRunRepositoryAdapter } from './core/adapters/prisma-ingestion-run-repository.adapter';
import { StartIngestionRunUseCase } from './core/use-cases/start-ingestion-run.use-case';
import { GetIngestionRunUseCase } from './core/use-cases/get-ingestion-run.use-case';
import { SubmitIngestionUseCase } from './core/use-cases/submit-ingestion.use-case';
import { GetIngestionStatusUseCase } from './core/use-cases/get-ingestion-status.use-case';
import { GetIngestionProgressUseCase } from './core/use-cases/get-ingestion-progress.use-case';
import { RetryIngestionRunUseCase } from './core/use-cases/retry-ingestion-run.use-case';
import { CaptureUrlUseCase } from './core/use-cases/capture-url.use-case';
import { ConfirmCapturedUrlUseCase } from './core/use-cases/confirm-captured-url.use-case';
import { UnifiedIngestUseCase } from './core/use-cases/unified-ingest.use-case';

const ingestionWorkerProviders = shouldRunWorkerConsumers()
  ? [IngestionQueueConsumer]
  : [];

/**
 * Ingestion Bounded Context — Processing Domain
 *
 * Unified NestJS module containing 3 logical sub-domains:
 *
 * ┌─────────────────────────────────────────────────────────┐
 * │  Sub-Domain 1: PIPELINE  (CPU-heavy, scale-out)         │
 * │  Queue: flux:library:ingestion:priority / :standard     │
 * │  Services: PipelineService, IngestionSagaOrchestrator,  │
 * │            IngestionQueueConsumer, QueueService,         │
 * │            IngestionService                              │
 * │  Extract path: ingestion/core/use-cases/pipeline/       │
 * ├─────────────────────────────────────────────────────────┤
 * │  Sub-Domain 2: ENRICHMENT  (I/O-bound, rate-limited)    │
 * │  External APIs: CrossRef, arXiv, PubMed, OpenAlex,      │
 * │                 OpenLibrary, Unpaywall, RetractionWatch  │
 * │  Services: MetadataService, ReconciliationService,      │
 * │            ExecutorService, DuplicateService,           │
 * │            QualityService, RetractionService,           │
 * │            RetractionDatabaseService, RetractionSync    │
 * │  Extract path: ingestion/core/use-cases/enrichment/     │
 * ├─────────────────────────────────────────────────────────┤
 * │  Sub-Domain 3: CAPTURE  (Network-bound, isolated)       │
 * │  Queue: flux:library:ingestion:capture                  │
 * │  Services: UrlCaptureService, UrlMetadataScraperService,│
 * │            WatchdogService                              │
 * │  Extract path: ingestion/core/use-cases/capture/        │
 * └─────────────────────────────────────────────────────────┘
 *
 * Migration to microservices: replace InProcessCatalogGatewayAdapter
 * with HttpCatalogGatewayAdapter — zero changes to domain logic required.
 */
@Module({
  imports: [
    CoreModule,
    SharedKernelModule,
    StorageModule,
    CatalogModule,
    ExtractionModule,
    SyncModule,
    BullModule.registerQueue(
      { name: LIBRARY_INGESTION_QUEUE_PRIORITY },
      { name: LIBRARY_INGESTION_QUEUE_STANDARD },
      { name: LIBRARY_INGESTION_QUEUE_CAPTURE },
    ),
  ],
  controllers: [IngestionController, CurationController, RetractionController],
  providers: [
    // Facade
    IngestionFacade,
    {
      provide: INGESTION_FACADE,
      useExisting: IngestionFacade,
    },
    {
      provide: PROCESSING_FACADE,
      useExisting: IngestionFacade,
    },

    // ── Gateway Ports & Adapters (Microservices Decoupling) ─────────
    InProcessCatalogGatewayAdapter,
    {
      provide: CATALOG_GATEWAY_PORT,
      useClass: InProcessCatalogGatewayAdapter,
    },
    InProcessExtractionGatewayAdapter,
    {
      provide: EXTRACTION_GATEWAY_PORT,
      useClass: InProcessExtractionGatewayAdapter,
    },

    // ── PIPELINE Sub-Domain (CPU-heavy — extract as worker process) ────────
    // Index: ingestion/core/use-cases/pipeline/
    IngestionRepository,
    IdempotencyRepository,
    IngestionService,
    {
      provide: INGESTION_PORT,
      useExisting: IngestionService,
    },
    PipelineService,
    IngestionSagaOrchestrator,
    QueueService,
    WatchdogService,
    ...ingestionWorkerProviders,

    // Parsers & Policies & Stages (pipeline infrastructure)
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

    // ── ENRICHMENT Sub-Domain (I/O-bound — separate rate-limited pod) ──────
    // Index: ingestion/core/use-cases/enrichment/
    // External APIs: CrossRef, arXiv, PubMed, OpenLibrary, OpenAlex, Unpaywall, RetractionWatch
    MetadataCache,
    ReconciliationService, // BibliographicReconcilerService
    ExecutorService, // EnrichmentStageExecutor (parallel provider execution + circuit breaker)
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
    MetadataService, // BibliographicEnricherService (multi-source orchestrator)
    {
      provide: METADATA_PORT,
      useExisting: MetadataService,
    },

    // Curation (part of Enrichment sub-domain)
    DuplicateService, // DuplicateDetectionService
    QualityService, // CatalogQualityAuditorService

    // Retraction Watch (part of Enrichment sub-domain)
    RetractionRepository,
    RetractionService,
    RetractionDatabaseService,
    RetractionScannerProvider,
    RetractionSyncService,

    // ── CAPTURE Sub-Domain (Network-bound — isolated queue) ────────────────
    // Index: ingestion/core/use-cases/capture/
    // Queue: flux:library:ingestion:capture
    UrlCaptureService,
    UrlMetadataScraperService,
    UrlCaptureProvider,

    // ── Clean Architecture Use Cases & Adapters ────────────────────────
    PrismaIngestionRunRepositoryAdapter,
    {
      provide: INGESTION_RUN_REPOSITORY_PORT,
      useClass: PrismaIngestionRunRepositoryAdapter,
    },
    StartIngestionRunUseCase,
    GetIngestionRunUseCase,
    SubmitIngestionUseCase,
    GetIngestionStatusUseCase,
    GetIngestionProgressUseCase,
    RetryIngestionRunUseCase,
    CaptureUrlUseCase,
    ConfirmCapturedUrlUseCase,
    UnifiedIngestUseCase,
  ],
  exports: [
    // Facade
    IngestionFacade,
    INGESTION_FACADE,
    ProcessingFacade,
    PROCESSING_FACADE,

    // Ports
    INGESTION_RUN_REPOSITORY_PORT,
    INGESTION_PORT,
    METADATA_PORT,
    CATALOG_GATEWAY_PORT,
    EXTRACTION_GATEWAY_PORT,

    // Use Cases
    StartIngestionRunUseCase,
    GetIngestionRunUseCase,
    SubmitIngestionUseCase,
    GetIngestionStatusUseCase,
    GetIngestionProgressUseCase,
    RetryIngestionRunUseCase,
    CaptureUrlUseCase,
    ConfirmCapturedUrlUseCase,
    UnifiedIngestUseCase,
    IngestionSagaOrchestrator,
  ],
})
export class IngestionModule {}
