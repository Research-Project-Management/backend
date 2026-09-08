import { Module, OnModuleInit } from '@nestjs/common';
import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';
import { PdfExtractorProvider } from './providers/pdf-extractor.provider';
import {
  AttachmentExtractionHandler,
  EXTRACTION_EVENT_TYPES,
} from './handlers/attachment-extraction.handler';
import { CoreModule } from '../../../core/core.module';
import { OutboxModule } from '../outbox/outbox.module';
import { OutboxWorker } from '../outbox/outbox.worker';
import { SearchModule } from '../search/search.module';
import { StorageModule } from '../../storage/storage.module';
import { ItemsModule } from '../items/items.module';
import { GrobidClient } from '../../../infra/grobid/grobid.client';

import { AttachmentsRepository } from './attachments.repository';
import { WebSnapshotService } from './services/web-snapshot.service';

@Module({
  imports: [
    CoreModule,
    OutboxModule,
    SearchModule,
    StorageModule,
    ItemsModule,
  ],
  controllers: [AttachmentsController],
  providers: [
    AttachmentsRepository,
    AttachmentsService,
    WebSnapshotService,
    GrobidClient, // OSS: GROBID client for structured PDF header extraction (Apache 2.0)
    PdfExtractorProvider,
    AttachmentExtractionHandler,
  ],
  exports: [AttachmentsService, WebSnapshotService, PdfExtractorProvider, GrobidClient],

})
export class AttachmentsModule implements OnModuleInit {
  constructor(
    private readonly outboxWorker: OutboxWorker,
    private readonly extractionHandler: AttachmentExtractionHandler,
  ) {}

  onModuleInit() {
    this.outboxWorker.registerHandler(
      EXTRACTION_EVENT_TYPES.EXTRACTION_REQUESTED,
      this.extractionHandler,
    );
  }
}
