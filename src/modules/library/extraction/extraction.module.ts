import { Global, Module, OnModuleInit, Optional, Inject } from '@nestjs/common';
import { CoreModule } from '@/core';
import {
  LibraryCoreModule,
  IOutboxRegistry,
  OUTBOX_REGISTRY_PORT,
} from '@/modules/library/core';

// Presentation
import { AttachmentController } from './controllers/attachments.controller';
import { AttachmentStorageController } from './controllers/attachment-storage.controller';
import { AnnotationsController } from './controllers/annotations.controller';
import { ExtractionTelemetryController } from './controllers/attachments.controller';

// Facades
import { ExtractionFacade, EXTRACTION_FACADE } from './services/extraction.facade';

// Services
import { AttachmentsService } from './services/attachments.service';
import { AttachmentRenamerService } from './services/attachment-renamer.service';
import { WebSnapshotService } from './services/web-snapshot.service';
import { AnnotationsService } from './services/annotations.service';
import { PdfAnnotationImporterService } from './services/pdf-annotation-importer.service';
import { ReferenceMatcherService } from './services/reference-matcher.service';
import { ExtractionMetadataSynchronizer } from './services/extraction-metadata.synchronizer';

// Repositories
import { AttachmentsRepository } from './repositories/attachments.repository';
import { ExtractionRepository } from './repositories/extraction.repository';
import { AnnotationsRepository } from './repositories/annotations.repository';

// Providers & Infrastructure
import { PdfProvider } from './providers/pdf.provider';
import { PdfMetadataExtractor } from './providers/pdf-metadata.extractor';
import { PdfTextMetadataExtractor } from './providers/pdf-text-metadata.extractor';
import {
  ExtractionHandler,
  EXTRACTION_EVENT_TYPES,
} from './services/extraction.handler';
import { ItemLifecycleSubscriber } from './services/item-lifecycle.subscriber';
import { AnnotationNormalizer } from './domain/annotations.domain';

@Global()
@Module({
  imports: [CoreModule, LibraryCoreModule],
  controllers: [
    AttachmentStorageController,
    AttachmentController,
    AnnotationsController,
    ExtractionTelemetryController,
  ],
  providers: [
    // Facades
    ExtractionFacade,
    {
      provide: EXTRACTION_FACADE,
      useExisting: ExtractionFacade,
    },

    // Repositories
    AttachmentsRepository,
    ExtractionRepository,
    AnnotationsRepository,

    // Services
    AttachmentsService,
    AttachmentRenamerService,
    WebSnapshotService,
    PdfMetadataExtractor,
    AnnotationsService,
    PdfAnnotationImporterService,
    ReferenceMatcherService,
    ExtractionMetadataSynchronizer,

    // Utilities & Providers
    PdfProvider,
    PdfTextMetadataExtractor,
    ExtractionHandler,
    ItemLifecycleSubscriber,
    AnnotationNormalizer,
  ],
  exports: [EXTRACTION_FACADE, ExtractionFacade],
})
export class ExtractionModule implements OnModuleInit {
  constructor(
    @Optional()
    @Inject(OUTBOX_REGISTRY_PORT)
    private readonly outboxWorker?: IOutboxRegistry,
    @Optional()
    private readonly extractionHandler?: ExtractionHandler,
  ) {}

  onModuleInit() {
    if (this.outboxWorker && this.extractionHandler) {
      this.outboxWorker.registerHandler(
        EXTRACTION_EVENT_TYPES.EXTRACTION_REQUESTED,
        this.extractionHandler,
      );
    }
  }
}
