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
import { ExtractionTelemetryController } from './controllers/extraction-telemetry.controller';

// Facades
import { ExtractionFacade, EXTRACTION_FACADE } from './extraction.facade';

// Services
import { AttachmentsService } from './services/attachments.service';
import { AttachmentRenamerService } from './services/attachment-renamer.service';
import { WebSnapshotService } from './services/web-snapshot.service';
import { OcrWorkerPoolService } from './services/ocr-worker-pool.service';
import { TrustedExtractionService } from './services/trusted-extraction.service';
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
import { PdfTextMetadataExtractor } from './providers/pdf-text-metadata.extractor';
import {
  OcrProvider,
  OcrPreprocessorService,
  OcrSandwichPdfService,
} from './providers/ocr.provider';
import {
  ExtractionHandler,
  EXTRACTION_EVENT_TYPES,
} from './services/extraction.handler';
import { ItemLifecycleSubscriber } from './subscribers/item-lifecycle.subscriber';
import { AnnotationNormalizer } from './domain/annotation.normalizer';

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
    OcrPreprocessorService,
    OcrWorkerPoolService,
    OcrSandwichPdfService,
    TrustedExtractionService,
    AnnotationsService,
    PdfAnnotationImporterService,
    ReferenceMatcherService,
    ExtractionMetadataSynchronizer,

    // Utilities & Providers
    OcrProvider,
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
