import { Global, Module } from '@nestjs/common';
import { CoreModule, shouldRunWorkerConsumers } from '@/core';
import { LibraryCoreModule } from '@/modules/library/core/core.module';
import { BullModule } from '@nestjs/bullmq';
import {
  LIBRARY_INGESTION_QUEUE_STANDARD,
  INGESTION_QUEUE_PORT,
  RETRACTION_DATABASE_PORT,
  RETRACTION_SERVICE_PORT,
} from './types/ingestion.types';

// Controllers
import {
  IngestionController,
  CurationController,
  RetractionController,
  FeedsController,
} from './controllers/ingestion.controller';
import { FeedsService, FeedsEngine } from './services/feeds.service';

import { IngestionService } from './services/ingestion.service';
import { PipelineService } from './services/pipeline.service';
import { PipelineSideEffectsService } from './services/pipeline-side-effects.service';
import { PipelineBatchExecutor } from './services/pipeline-batch.executor';
import { MetadataResolverService } from './services/metadata-resolver.service';
import { IngestionRunReporterService } from './services/ingestion-saga.orchestrator';
import { IngestionSagaOrchestrator } from './services/ingestion-saga.orchestrator';
import { QueueService, IngestionQueueConsumer } from './services/queue.service';
import { UrlCaptureService } from './services/url-capture.service';
import { FeedRetrievalService } from './services/feed-retrieval.service';
import { UrlMetadataScraperService } from './services/url-metadata-scraper.service';
import { PublisherDomExtractor } from './parsers/publisher-dom.extractor';
import { HtmlMetaTagExtractor } from './parsers/html-meta-tag.extractor';
import { MetadataExecutorService } from './services/metadata-executor.service';
import { MetadataService } from './services/metadata.service';
import { DuplicateDetectorService } from './services/duplicate-detector.service';
import { DuplicateMergerService } from './services/duplicate-merger.service';
import { RetractionService } from './services/retraction.service';
import {
  QualityService,
  IngestionVerifierService,
  IngestionFacade,
  INGESTION_FACADE,
} from './services/ingestion-verifier.service';
import { RetractionDatabaseService } from './services/retraction-database.service';
import { RetractionSyncService } from './services/retraction.service';
import { RetractionSeederService } from './services/retraction-seeder.service';
import { SeedRetractionsCommand } from './services/retraction-seeder.service';
import {
  WebFetchLadderService,
  WebMirrorResolverService,
} from './services/web-fetch-ladder.service';
import { DomainRateLimiterService } from './services/feed-retrieval.service';

// Repositories
import { IngestionRepository } from './repositories/ingestion.repository';
import { DuplicateMergeRepository } from './repositories/duplicate-merge.repository';
import { MetadataCache } from './services/retraction-seeder.service';
import { RetractionRepository } from './repositories/retraction.repository';
import { FeedsRepository } from './repositories/feeds.repository';

// Types & Ports
import {
  METADATA_PROVIDERS,
  METADATA_PORT,
  WEB_FETCH_PORT,
  URL_METADATA_SCRAPER_PORT,
  INGESTION_VERIFIER_PORT,
  MetadataProvider,
} from './types/metadata.types';

// Parsers & Policies & Stages & Providers
import { BibtexParser, DoiParser } from './parsers/bibtex.parser';
import { RisParser } from './parsers/ris.parser';
import { CslParser } from './parsers/csl.parser';
import { XmlLegacyFormatsParser } from './parsers/xml-legacy-formats.parser';
import { BibliographyFormatRegistry } from './parsers/bibliography-format.registry';
import { NormalizationPolicy } from './domain/normalization.policy';
import { DuplicatePolicy } from './domain/deduplication.domain';
import { IdentifyStage, IdentifyUrlResolver } from './stages/identify.stage';
import { IdentifyFileResolver } from './stages/identify-file.resolver';
import { ResolveStage } from './stages/resolve.stage';
import { CommitStage } from './stages/commit.stage';
import { UrlCaptureProvider } from './providers/url-capture.provider';
import { CrossRefProvider } from './providers/crossref.provider';
import { ArxivProvider } from './providers/arxiv.provider';
import { PubMedProvider } from './providers/pubmed.provider';
import { OpenLibraryProvider } from './providers/semantic-scholar.provider';
import { OpenAlexProvider } from './providers/openalex.provider';
import { UnpaywallProvider } from './providers/semantic-scholar.provider';
import { RetractionScannerProvider } from './providers/base-metadata.provider';
import { DblpProvider } from './providers/arxiv.provider';
import { SemanticScholarProvider } from './providers/semantic-scholar.provider';
import { RetractionItemEventsSubscriber } from './services/retraction-seeder.service';

const ingestionWorkerProviders = shouldRunWorkerConsumers()
  ? [IngestionQueueConsumer]
  : [];

@Global()
@Module({
  imports: [
    CoreModule,
    LibraryCoreModule,
    BullModule.registerQueue({ name: LIBRARY_INGESTION_QUEUE_STANDARD }),
  ],
  controllers: [
    IngestionController,
    CurationController,
    RetractionController,
    FeedsController,
  ],
  providers: [
    FeedsService,
    // Facade
    IngestionFacade,
    {
      provide: INGESTION_FACADE,
      useExisting: IngestionFacade,
    },

    // Repositories
    IngestionRepository,
    DuplicateMergeRepository,
    MetadataCache,
    RetractionRepository,
    FeedsRepository,

    // Services
    IngestionService,
    PipelineService,
    PipelineSideEffectsService,
    PipelineBatchExecutor,
    MetadataResolverService,
    IngestionRunReporterService,
    IngestionSagaOrchestrator,
    QueueService,
    {
      provide: INGESTION_QUEUE_PORT,
      useExisting: QueueService,
    },
    UrlCaptureService,
    FeedRetrievalService,
    FeedsEngine,
    UrlMetadataScraperService,
    {
      provide: URL_METADATA_SCRAPER_PORT,
      useExisting: UrlMetadataScraperService,
    },
    PublisherDomExtractor,
    HtmlMetaTagExtractor,
    IngestionVerifierService,
    {
      provide: INGESTION_VERIFIER_PORT,
      useExisting: IngestionVerifierService,
    },
    WebMirrorResolverService,
    WebFetchLadderService,
    {
      provide: WEB_FETCH_PORT,
      useExisting: WebFetchLadderService,
    },
    ...ingestionWorkerProviders,

    // Parsers & Policies & Stages
    DoiParser,
    BibtexParser,
    RisParser,
    CslParser,
    XmlLegacyFormatsParser,
    BibliographyFormatRegistry,
    { provide: NormalizationPolicy, useClass: NormalizationPolicy },
    { provide: DuplicatePolicy, useClass: DuplicatePolicy },
    IdentifyFileResolver,
    IdentifyUrlResolver,
    IdentifyStage,
    ResolveStage,
    CommitStage,
    UrlCaptureProvider,

    // Metadata Providers & Enrichment
    DomainRateLimiterService,
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
    DuplicateDetectorService,
    DuplicateMergerService,
    QualityService,

    // Retraction Watch
    RetractionService,
    {
      provide: RETRACTION_SERVICE_PORT,
      useExisting: RetractionService,
    },
    RetractionDatabaseService,
    {
      provide: RETRACTION_DATABASE_PORT,
      useExisting: RetractionDatabaseService,
    },
    RetractionScannerProvider,
    RetractionSyncService,
    RetractionSeederService,
    SeedRetractionsCommand,
    RetractionItemEventsSubscriber,
  ],
  exports: [
    INGESTION_FACADE,
    IngestionFacade,
    METADATA_PORT,
    RetractionSeederService,
    SeedRetractionsCommand,
  ],
})
export class IngestionModule {}
