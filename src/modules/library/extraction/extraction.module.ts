import { Module, OnModuleInit, Optional, Inject } from '@nestjs/common';
import { CoreModule } from '../../../core/core.module';
import { StorageModule } from '../../storage/storage.module';
import {
  SharedKernelModule,
  IOutboxRegistry,
  OUTBOX_REGISTRY_PORT,
} from '../shared-kernel';

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

// Repositories
import { AttachmentsRepository } from './repositories/attachments.repository';
import { ExtractionRepository } from './repositories/extraction.repository';
import { AnnotationsRepository } from './repositories/annotations.repository';

// Utilities & Providers
import { PdfProvider } from './utils/pdf.provider';
import { OcrProvider } from './utils/ocr.provider';
import {
  ExtractionHandler,
  EXTRACTION_EVENT_TYPES,
} from './utils/extraction.handler';
import { ItemLifecycleSubscriber } from './utils/item-lifecycle.subscriber';
import { AnnotationNormalizer } from './utils/annotation.normalizer';
import { InProcessCatalogGatewayAdapter } from './utils/in-process-catalog-gateway.adapter';
import { HttpCatalogGatewayAdapter } from './utils/http-catalog-gateway.adapter';
import {
  XmpParser,
  AcademicRegexCatalog,
  MetadataQualityGate,
  LayoutHeuristicExtractor,
  MeXtractExtractor,
} from './extractors';

// Tokens
import { TRUSTED_EXTRACTOR_PORT } from './types/trusted-extraction.types';
import { CATALOG_GATEWAY_PORT } from './types/catalog-gateway.types';
import { ATTACHMENT_REPOSITORY_PORT } from './types/attachments.types';
import { ANNOTATION_REPOSITORY_PORT } from './types/annotations.types';

@Module({
  imports: [CoreModule, StorageModule, SharedKernelModule],
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
    {
      provide: ATTACHMENT_REPOSITORY_PORT,
      useExisting: AttachmentsRepository,
    },
    {
      provide: ANNOTATION_REPOSITORY_PORT,
      useExisting: AnnotationsRepository,
    },

    // Services
    AttachmentsService,
    WebSnapshotService,
    OcrPreprocessorService,
    OcrWorkerPoolService,
    OcrSandwichPdfService,
    TrustedExtractionService,
    {
      provide: TRUSTED_EXTRACTOR_PORT,
      useExisting: TrustedExtractionService,
    },
    AnnotationsService,
    PdfAnnotationImporterService,

    // Utilities & Providers
    OcrProvider,
    PdfProvider,
    ExtractionHandler,
    ItemLifecycleSubscriber,
    AnnotationNormalizer,
    InProcessCatalogGatewayAdapter,
    HttpCatalogGatewayAdapter,
    {
      provide: CATALOG_GATEWAY_PORT,
      useFactory: (
        inProcess: InProcessCatalogGatewayAdapter,
        http: HttpCatalogGatewayAdapter,
      ) => {
        return process.env.LIBRARY_CATALOG_URL ? http : inProcess;
      },
      inject: [InProcessCatalogGatewayAdapter, HttpCatalogGatewayAdapter],
    },
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
    ExtractionRepository,
    AttachmentsRepository,
    OcrSandwichPdfService,
    OcrWorkerPoolService,
    OcrPreprocessorService,
    ATTACHMENT_REPOSITORY_PORT,

    // Trusted Extraction Exports
    TRUSTED_EXTRACTOR_PORT,
    TrustedExtractionService,
    XmpParser,
    AcademicRegexCatalog,
    MetadataQualityGate,
    LayoutHeuristicExtractor,
    MeXtractExtractor,

    // Annotation domain exports
    AnnotationsService,
    AnnotationNormalizer,
    ANNOTATION_REPOSITORY_PORT,
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
