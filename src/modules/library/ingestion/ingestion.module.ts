import { Global, Module } from '@nestjs/common';
import { CoreModule, shouldRunWorkerConsumers } from '@/core';
import { LibraryCoreModule } from '@/modules/library/core/core.module';
import { BullModule } from '@nestjs/bullmq';
import { LIBRARY_INGESTION_QUEUE_STANDARD } from './types/ingestion.types';

// Facade
import { IngestionFacade, INGESTION_FACADE } from './ingestion.facade';

// Controllers
import { IngestionController } from './controllers/ingestion.controller';
import { CurationController } from './controllers/curation.controller';
import { RetractionController } from './controllers/retraction.controller';
import { FeedsController } from './controllers/feeds.controller';
import { FeedsService, FeedsEngine } from './services/feeds.service';

import { IngestionService } from './services/ingestion.service';
import { PipelineService } from './services/pipeline.service';
import { PipelineSideEffectsService } from './services/pipeline-side-effects.service';
import { PipelineBatchExecutor } from './services/pipeline-batch.executor';
import { MetadataResolverService } from './services/metadata-resolver.service';
import { IngestionRunReporterService } from './services/ingestion-run-reporter.service';
import {
  IngestionSagaOrchestrator,
  IngestionQueueConsumer,
} from './services/ingestion-saga.orchestrator';
import { QueueService } from './services/queue.service';
import { UrlCaptureService } from './services/url-capture.service';
import { FeedRetrievalService } from './services/feed-retrieval.service';
import { UrlMetadataScraperService } from './services/url-metadata-scraper.service';
import { PublisherDomExtractor } from './services/publisher-dom.extractor';
import { HtmlMetaTagExtractor } from './services/html-meta-tag.extractor';
import { MetadataExecutorService } from './services/metadata-executor.service';
import { MetadataService } from './services/metadata.service';
import { DuplicateDetectorService } from './services/duplicate-detector.service';
import { DuplicateMergerService } from './services/duplicate-merger.service';
import { RetractionService, QualityService } from './services/retraction.service';
import { RetractionDatabaseService } from './services/retraction-database.service';
import { RetractionSyncService } from './services/retraction-sync.service';
import { RetractionSeederService } from './services/retraction-seeder.service';
import { SeedRetractionsCommand } from './commands/seed-retractions.command';
import { IngestionVerifierService } from './services/ingestion-verifier.service';
import {
  WebFetchLadderService,
  WebMirrorResolverService,
} from './services/web-fetch-ladder.service';
import { DomainRateLimiterService } from './services/domain-rate-limiter.service';

// Repositories
import { IngestionRepository } from './repositories/ingestion.repository';
import { DuplicateMergeRepository } from './repositories/duplicate-merge.repository';
import { MetadataCache } from './repositories/metadata.cache';
import { RetractionRepository } from './repositories/retraction.repository';
import { FeedsRepository } from './repositories/feeds.repository';

// Types & Ports
import {
  METADATA_PROVIDERS,
  METADATA_PORT,
  WEB_FETCH_PORT,
  MetadataProvider,
} from './types/metadata.types';

// Parsers & Policies & Stages & Providers
import { BibtexParser, DoiParser } from './parsers/bibtex.parser';
import { RisParser } from './parsers/ris.parser';
import { CslParser } from './parsers/csl.parser';
import { XmlLegacyFormatsParser } from './parsers/xml-legacy-formats.parser';
import { BibliographyFormatRegistry } from './parsers/bibliography-format.registry';
import { NormalizationPolicy } from './policies/normalization.policy';
import { DuplicatePolicy } from './policies/metadata.policy';
import { IdentifyStage, IdentifyUrlResolver } from './stages/identify.stage';
import { IdentifyFileResolver } from './stages/identify-file.resolver';
import { ResolveStage } from './stages/resolve.stage';
import { CommitStage } from './stages/commit.stage';
import { UrlCaptureProvider } from './providers/url-capture.provider';
import { CrossRefProvider } from './providers/crossref.provider';
import { ArxivProvider } from './providers/arxiv.provider';
import { PubMedProvider } from './providers/pubmed.provider';
import { OpenLibraryProvider } from './providers/openlibrary.provider';
import { OpenAlexProvider } from './providers/openalex.provider';
import { UnpaywallProvider } from './providers/unpaywall.provider';
import { RetractionScannerProvider } from './providers/retraction-scanner.provider';
import { DblpProvider } from './providers/dblp.provider';
import { SemanticScholarProvider } from './providers/semantic-scholar.provider';
import { RetractionItemEventsSubscriber } from './subscribers/retraction-item-events.subscriber';

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
    UrlCaptureService,
    FeedRetrievalService,
    FeedsEngine,
    UrlMetadataScraperService,
    PublisherDomExtractor,
    HtmlMetaTagExtractor,
    IngestionVerifierService,
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
    RetractionDatabaseService,
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
