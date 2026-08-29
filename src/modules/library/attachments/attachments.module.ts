import { Module, OnModuleInit } from '@nestjs/common';
import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';
import { ExtractorService } from './providers/extractor.provider';
import {
  AttachmentExtractionHandler,
  EXTRACTION_EVENT_TYPES,
} from './handlers/attachment-extraction.handler';
import { CoreModule } from '../../../core/core.module';
import { SyncModule } from '../sync/sync.module';
import { SearchModule } from '../search/search.module';
import { OutboxWorker } from '../sync/outbox.worker';
import { StorageModule } from '../../storage/storage.module';

@Module({
  imports: [CoreModule, SyncModule, SearchModule, StorageModule],
  controllers: [AttachmentsController],
  providers: [
    AttachmentsService,
    ExtractorService,
    AttachmentExtractionHandler,
  ],
  exports: [AttachmentsService, ExtractorService, AttachmentExtractionHandler],
})
export class AttachmentsModule implements OnModuleInit {
  constructor(
    private readonly outboxWorker: OutboxWorker,
    private readonly extractionHandler: AttachmentExtractionHandler,
  ) {}

  onModuleInit() {
    if (
      !this.outboxWorker.hasHandler(EXTRACTION_EVENT_TYPES.EXTRACTION_REQUESTED)
    ) {
      this.outboxWorker.registerHandler(
        EXTRACTION_EVENT_TYPES.EXTRACTION_REQUESTED,
        this.extractionHandler,
      );
    }
  }
}
