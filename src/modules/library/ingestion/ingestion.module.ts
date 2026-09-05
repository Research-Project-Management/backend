import { Module } from '@nestjs/common';
import { CoreModule } from '../../../core/core.module';
import { OutboxModule } from '../outbox/outbox.module';
import { ItemsModule } from '../items/items.module';
import { AttachmentsModule } from '../attachments/attachments.module';
import { SearchModule } from '../search/search.module';
import { MetadataModule } from './metadata/metadata.module';
import { StorageModule } from '../../storage/storage.module';
import { IngestionService } from './ingestion.service';
import { IngestionController } from './ingestion.controller';
import { IngestionRepository } from './ingestion.repository';
import { IdempotencyRepository } from '../sync/repositories/idempotency.repository';
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
import { DoiIngestionStrategy } from './strategies/doi-ingestion.strategy';
import { UrlIngestionStrategy } from './strategies/url-ingestion.strategy';
import { PdfIngestionStrategy } from './strategies/pdf-ingestion.strategy';
import { BibtexIngestionStrategy } from './strategies/bibtex-ingestion.strategy';
import { IngestionStrategyRegistry } from './strategies/ingestion-strategy.registry';

import { NotesModule } from '../notes/notes.module';

@Module({
  imports: [
    CoreModule,
    OutboxModule,
    ItemsModule,
    AttachmentsModule,
    SearchModule,
    MetadataModule,
    StorageModule,
    NotesModule,
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

    // Strategies
    DoiIngestionStrategy,
    UrlIngestionStrategy,
    PdfIngestionStrategy,
    BibtexIngestionStrategy,
    IngestionStrategyRegistry,

    // Service & Adapters
    IngestionService,
    {
      provide: INGESTION_PORT,
      useExisting: IngestionService,
    },
    UrlCaptureProvider,
  ],
  exports: [
    INGESTION_PORT,
    IngestionService,
    IngestionStrategyRegistry,
    DoiParser,
    BibtexParser,
    RisParser,
  ],
})
export class IngestionModule {}
