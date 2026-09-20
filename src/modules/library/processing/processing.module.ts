import { Module, forwardRef } from '@nestjs/common';
import { CoreModule } from '../../../core/core.module';
import { SharedKernelModule } from '../shared-kernel/shared-kernel.module';
import { StorageModule } from '../../storage/storage.module';
import { CatalogModule } from '../catalog/catalog.module';
import { ContentModule } from '../content/content.module';
import { DiscoveryModule } from '../discovery/discovery.module';
import { BullModule } from '@nestjs/bullmq';
import { LIBRARY_INGESTION_QUEUE } from './domain/constants/queue.constants';
import { shouldRunWorkerConsumers } from '../../../core/utils/worker-mode.util';

// Facade
import { ProcessingFacade, PROCESSING_FACADE } from './processing.facade';

// ── 1. Ingestion Pipeline ─────────────────────────────────────────────────
import { IngestionController } from './presentation/ingestion.controller';
import { IngestionService } from './application/services/ingestion.service';
import { IngestionRepository } from './infrastructure/repositories/ingestion.repository';
import { IdempotencyRepository } from './infrastructure/repositories/idempotency.repository';
import { DoiParser } from './infrastructure/parsers/doi.parser';
import { BibtexParser } from './infrastructure/parsers/bibtex.parser';
import { RisParser } from './infrastructure/parsers/ris.parser';
import { NormalizationPolicy } from './domain/policies/normalization.policy';
import { ReconciliationPolicy } from './domain/policies/reconciliation.policy';
import { DuplicatePolicy } from './domain/policies/duplicate.policy';
import { IdentifyStage } from './infrastructure/stages/identify.stage';
import { NormalizeStage } from './infrastructure/stages/normalize.stage';
import { EnrichStage } from './infrastructure/stages/enrich.stage';
import { ReconcileStage } from './infrastructure/stages/reconcile.stage';
import { MatchStage } from './infrastructure/stages/match.stage';
import { CommitStage } from './infrastructure/stages/commit.stage';
import { UrlCaptureProvider } from './infrastructure/providers/url-capture.provider';
import { INGESTION_PORT } from './domain/types/ingestion.types';
import { WatchdogService } from './application/services/watchdog.service';
import { UrlCaptureService } from './application/services/url-capture.service';
import { PipelineService } from './application/services/pipeline.service';
import { QueueService } from './application/services/queue.service';
import { IngestionQueueConsumer } from './application/services/ingestion-queue.consumer';
import { UrlMetadataScraperService } from './application/services/url-metadata-scraper.service';

// ── 2. Metadata Resolution ────────────────────────────────────────────────
import {
  METADATA_PROVIDERS,
  METADATA_PORT,
  MetadataProvider,
} from './domain/types/metadata.types';
import { MetadataCache } from './infrastructure/cache/metadata.cache';
import { ReconciliationService } from './application/services/metadata-reconciliation.service';
import { ExecutorService } from './application/services/metadata-executor.service';
import { MetadataService } from './application/services/metadata.service';
import { CrossRefProvider } from './infrastructure/providers/crossref.provider';
import { ArxivProvider } from './infrastructure/providers/arxiv.provider';
import { PubMedProvider } from './infrastructure/providers/pubmed.provider';
import { OpenLibraryProvider } from './infrastructure/providers/openlibrary.provider';
import { OpenAlexProvider } from './infrastructure/providers/openalex.provider';
import { UnpaywallProvider } from './infrastructure/providers/unpaywall.provider';

// ── 3. Curation / Deduplication ──────────────────────────────────────────
import { CurationController } from './presentation/curation.controller';
import { DuplicateService } from './application/services/duplicate.service';
import { QualityService } from './application/services/quality.service';

// ── 4. Retraction Watch ──────────────────────────────────────────────────
import { RetractionController } from './presentation/retraction.controller';
import { RetractionService } from './application/services/retraction.service';
import { RetractionRepository } from './infrastructure/repositories/retraction.repository';
import { RetractionScannerProvider } from './infrastructure/providers/retraction-scanner.provider';
import { RetractionDatabaseService } from './application/services/retraction-database.service';
import { RetractionSyncService } from './application/services/retraction-sync.service';

// ── Clean Architecture — Ingestion Run Port & Use Cases ──────────────────
import { INGESTION_RUN_REPOSITORY_PORT } from './domain/ports/ingestion-run-repository.port';
import { PrismaIngestionRunRepositoryAdapter } from './infrastructure/adapters/prisma-ingestion-run-repository.adapter';
import { StartIngestionRunUseCase } from './application/commands/start-ingestion-run.use-case';
import { GetIngestionRunUseCase } from './application/queries/get-ingestion-run.use-case';

const ingestionWorkerProviders = shouldRunWorkerConsumers()
  ? [IngestionQueueConsumer]
  : [];

/**
 * Processing Bounded Context Unified Module (Supporting Domain).
 *
 * Consolidates all ingestion, metadata extraction, curation, and retraction check features
 * into a single Clean Architecture module:
 * - Ingestion (Multi-stage pipeline, Queue runner, Parsers, Stages, Watchdog)
 * - Metadata (Multi-source resolution: CrossRef, Arxiv, PubMed, OpenLibrary, OpenAlex, Unpaywall)
 * - Curation (Duplicate detection, Quality assessment)
 * - Retraction (Retraction Watch DB sync, Delta scanner)
 */
@Module({
  imports: [
    CoreModule,
    SharedKernelModule,
    StorageModule,
    forwardRef(() => CatalogModule),
    forwardRef(() => ContentModule),
    forwardRef(() => DiscoveryModule),
    BullModule.registerQueue({
      name: LIBRARY_INGESTION_QUEUE,
    }),
  ],
  controllers: [IngestionController, CurationController, RetractionController],
  providers: [
    // Facade
    ProcessingFacade,
    {
      provide: PROCESSING_FACADE,
      useExisting: ProcessingFacade,
    },

    // ── Ingestion Providers ────────────────────────────────────────────
    IngestionRepository,
    IdempotencyRepository,
    IngestionService,
    {
      provide: INGESTION_PORT,
      useExisting: IngestionService,
    },
    UrlCaptureService,
    UrlMetadataScraperService,
    UrlCaptureProvider,
    PipelineService,
    QueueService,
    WatchdogService,
    ...ingestionWorkerProviders,

    // Parsers & Policies & Stages
    DoiParser,
    BibtexParser,
    RisParser,
    NormalizationPolicy,
    ReconciliationPolicy,
    DuplicatePolicy,
    IdentifyStage,
    NormalizeStage,
    EnrichStage,
    ReconcileStage,
    MatchStage,
    CommitStage,

    // ── Metadata Providers ─────────────────────────────────────────────
    MetadataCache,
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

    // ── Curation Providers ─────────────────────────────────────────────
    DuplicateService,
    QualityService,

    // ── Retraction Providers ───────────────────────────────────────────
    RetractionRepository,
    RetractionService,
    RetractionDatabaseService,
    RetractionScannerProvider,
    RetractionSyncService,

    // ── Clean Architecture Use Cases & Adapters ────────────────────────
    PrismaIngestionRunRepositoryAdapter,
    {
      provide: INGESTION_RUN_REPOSITORY_PORT,
      useClass: PrismaIngestionRunRepositoryAdapter,
    },
    StartIngestionRunUseCase,
    GetIngestionRunUseCase,
  ],
  exports: [
    // Facade
    ProcessingFacade,
    PROCESSING_FACADE,

    // Ports
    INGESTION_RUN_REPOSITORY_PORT,
    INGESTION_PORT,
    METADATA_PORT,
  ],

})
export class ProcessingModule {}
