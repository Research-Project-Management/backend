import { Module, OnModuleInit, Optional, Inject } from '@nestjs/common';
import { CoreModule } from '@/core';
import { StorageModule } from '@/modules/storage/storage.module';
import { CatalogModule } from '@/modules/library/catalog/catalog.module';
import {
  LibraryCoreModule,
  IOutboxRegistry,
  OUTBOX_REGISTRY_PORT,
} from '@/modules/library/core';

// Presentation
import {
  AttachmentController,
  ProjectAttachmentController,
} from './controllers/attachments.controller';
import {
  AttachmentStorageController,
  ProjectAttachmentStorageController,
} from './controllers/attachment-storage.controller';
import { AnnotationsController } from './controllers/annotations.controller';
import { ExtractionTelemetryController } from './controllers/extraction-telemetry.controller';

// Facades
import { ExtractionFacade, EXTRACTION_FACADE } from './extraction.facade';

// Services
import { AttachmentsService } from './services/attachments.service';
import { WebSnapshotService } from './services/web-snapshot.service';
import { OcrPreprocessorService } from './services/ocr-preprocessor.service';
import { OcrWorkerPoolService } from './services/ocr-worker-pool.service';
import { OcrSandwichPdfService } from './services/ocr-sandwich-pdf.service';
import { TrustedExtractionService } from './services/trusted-extraction.service';
import { AnnotationsService } from './services/annotations.service';
import { PdfAnnotationImporterService } from './services/pdf-annotation-importer.service';
import { ReferenceMatcherService } from './services/reference-matcher.service';

// Repositories
import { AttachmentsRepository } from './repositories/attachments.repository';
import { ExtractionRepository } from './repositories/extraction.repository';
import { AnnotationsRepository } from './repositories/annotations.repository';

// Providers & Infrastructure
import { PdfProvider } from './providers/pdf.provider';
import { OcrProvider } from './providers/ocr.provider';
import {
  ExtractionHandler,
  EXTRACTION_EVENT_TYPES,
} from './services/extraction.handler';
import { ItemLifecycleSubscriber } from './subscribers/item-lifecycle.subscriber';
import { AnnotationNormalizer } from './domain/annotation.normalizer';
import { XmpParser } from './extractors/xmp.parser';
import { AcademicRegexCatalog } from '@/modules/library/core/domain/academic-regex.catalog';
import { MetadataQualityGate } from './extractors/metadata-quality.gate';
import { LayoutHeuristicExtractor } from './extractors/layout-heuristic.extractor';
import { MeXtractExtractor } from './extractors/mextract.extractor';

@Module({
  imports: [CoreModule, StorageModule, LibraryCoreModule, CatalogModule],
  controllers: [
    AttachmentStorageController,
    ProjectAttachmentStorageController,
    AttachmentController,
    ProjectAttachmentController,
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
    WebSnapshotService,
    OcrPreprocessorService,
    OcrWorkerPoolService,
    OcrSandwichPdfService,
    TrustedExtractionService,
    AnnotationsService,
    PdfAnnotationImporterService,
    ReferenceMatcherService,

    // Utilities & Providers
    OcrProvider,
    PdfProvider,
    ExtractionHandler,
    ItemLifecycleSubscriber,
    AnnotationNormalizer,
    XmpParser,
    AcademicRegexCatalog,
    MetadataQualityGate,
    LayoutHeuristicExtractor,
    MeXtractExtractor,
  ],
  exports: [
    ExtractionFacade,
    EXTRACTION_FACADE,
    AttachmentsService,
    PdfProvider,
    OcrProvider,
    ExtractionHandler,
    ReferenceMatcherService,
    OcrSandwichPdfService,
    OcrWorkerPoolService,
    OcrPreprocessorService,

    // Trusted Extraction Exports
    TrustedExtractionService,
    XmpParser,
    AcademicRegexCatalog,
    MetadataQualityGate,
    LayoutHeuristicExtractor,
    MeXtractExtractor,

    // Annotation domain exports
    AnnotationsService,
    AnnotationNormalizer,
    PdfAnnotationImporterService,
  ],
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
