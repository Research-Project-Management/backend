import { Module } from '@nestjs/common';
import { CoreModule } from '../../../core/core.module';
import { OutboxModule } from '../outbox/outbox.module';
import { ItemsModule } from '../items/items.module';
import { AttachmentsModule } from '../attachments/attachments.module';
import { SearchModule } from '../search/search.module';
import { MetadataModule } from './metadata/metadata.module';
import { StorageModule } from '../../storage/storage.module';
import { TypesModule } from '../types/types.module';
import { IngestionService } from './ingestion.service';
import { IngestionController } from './ingestion.controller';
import { IngestionRepository } from './ingestion.repository';
import { IdempotencyRepository } from './repositories/idempotency.repository';
import { DoiParser } from './parsers/doi.parser';
import { BibtexParser } from './parsers/bibtex.parser';
import { RisParser } from './parsers/ris.parser';
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
import { INGESTION_PORT } from './types/ingestion.types';
import {
  WatchdogService,
  IngestionWatchdogService,
} from './services/watchdog.service';
import { UrlCaptureService } from './services/url-capture.service';
import {
  PipelineService,
  IngestionPipelineRunner,
} from './services/pipeline.service';
import { QueueService } from './services/queue.service';
import { InfraModule } from '../infra/infra.module';
import { CoreModule as LibraryCoreModule } from '../core/core.module';
import { BullModule } from '@nestjs/bullmq';
import { LIBRARY_INGESTION_QUEUE } from './constants/queue.constants';
import { IngestionQueueConsumer } from './services/ingestion-queue.consumer';
import { NotesModule } from '../notes/notes.module';
import { UrlMetadataScraperService } from './services/url-metadata-scraper.service';

@Module({
  imports: [
    CoreModule,
    LibraryCoreModule,
    InfraModule,
    OutboxModule,
    ItemsModule,
    AttachmentsModule,
    SearchModule,
    MetadataModule,
    StorageModule,
    NotesModule,
    TypesModule,
    BullModule.registerQueue({
      name: LIBRARY_INGESTION_QUEUE,
    }),
  ],
  controllers: [IngestionController],
  providers: [
    // Repository
    IngestionRepository,
    IdempotencyRepository,

    // Parsers
    DoiParser,
    BibtexParser,
    RisParser,

    // Policies
    NormalizationPolicy,
    ReconciliationPolicy,
    DuplicatePolicy,

    // Stages
    IdentifyStage,
    NormalizeStage,
    EnrichStage,
    ReconcileStage,
    MatchStage,
    CommitStage,

    // Service & Adapters
    UrlCaptureService,
    PipelineService,
    QueueService,
    IngestionQueueConsumer,
    IngestionService,
    WatchdogService,
    {
      provide: INGESTION_PORT,
      useExisting: IngestionService,
    },
    UrlCaptureProvider,
    UrlMetadataScraperService,
  ],
  exports: [
    INGESTION_PORT,
    IngestionService,
    PipelineService,
    QueueService,
    IngestionQueueConsumer,
    UrlCaptureService,
    UrlMetadataScraperService,
    WatchdogService,
    IngestionPipelineRunner,
    IngestionWatchdogService,
    DoiParser,
    BibtexParser,
    RisParser,
  ],
})
export class IngestionModule {}
