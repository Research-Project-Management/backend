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

import { AttachmentsRepository } from './attachments.repository';

@Module({
  imports: [
    CoreModule,
    OutboxModule,
    SearchModule,
    StorageModule,
  ],
  controllers: [AttachmentsController],
  providers: [
    AttachmentsRepository,
    AttachmentsService,
    PdfExtractorProvider,
    AttachmentExtractionHandler,
  ],
  exports: [AttachmentsService, PdfExtractorProvider],
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
