import { Module, OnModuleInit, Inject } from '@nestjs/common';
import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';
import { PdfExtractorProvider } from './providers/pdf-extractor.provider';
import {
  AttachmentExtractionHandler,
  EXTRACTION_EVENT_TYPES,
} from './handlers/attachment-extraction.handler';
import { CoreModule } from '../../../core/core.module';
import { SyncModule } from '../sync/sync.module';
import { SearchModule } from '../search/search.module';
import { SYNC_PORT, SyncPort } from '../sync/ports/sync.port';
import { StorageModule } from '../../storage/storage.module';

@Module({
  imports: [CoreModule, SyncModule, SearchModule, StorageModule],
  controllers: [AttachmentsController],
  providers: [
    AttachmentsService,
    PdfExtractorProvider,
    AttachmentExtractionHandler,
  ],
  exports: [AttachmentsService, PdfExtractorProvider],
})
export class AttachmentsModule implements OnModuleInit {
  constructor(
    @Inject(SYNC_PORT)
    private readonly syncPort: SyncPort,
    private readonly extractionHandler: AttachmentExtractionHandler,
  ) {}

  onModuleInit() {
    this.syncPort.registerIntegrationEventHandler(
      EXTRACTION_EVENT_TYPES.EXTRACTION_REQUESTED,
      (evt) => this.extractionHandler.handle(evt as any),
    );
  }
}
