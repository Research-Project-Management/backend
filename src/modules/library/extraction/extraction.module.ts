import { Module, OnModuleInit, forwardRef } from '@nestjs/common';
import { CoreModule } from '../../../core/core.module';
import { StorageModule } from '../../storage/storage.module';
import { SyncModule } from '../sync/sync.module';
import { OutboxWorker } from '../sync/core/adapters/outbox.worker';

// Presentation
import {
  AttachmentController,
  AttachmentsController,
} from './attachments.controller';

// Facades
import {
  ExtractionFacade,
  EXTRACTION_FACADE,
  ReaderFacade,
  READER_FACADE,
  ContentFacade,
  CONTENT_FACADE,
} from './extraction.facade';

// Services & Infrastructure
import {
  AttachmentService,
  AttachmentsService,
} from './core/use-cases/attachments.service';
import { AttachmentsRepository } from './core/adapters/attachments.repository';
import { ExtractionRepository } from './core/adapters/extraction.repository';
import { PdfProvider } from './core/adapters/pdf.provider';
import { OcrProvider } from './core/adapters/ocr.provider';
import { OcrPreprocessorService } from './core/adapters/ocr-preprocessor.service';
import { OcrWorkerPoolService } from './core/adapters/ocr-worker-pool.service';
import { OcrSandwichPdfService } from './core/adapters/ocr-sandwich-pdf.service';
import { WebSnapshotService } from './core/adapters/web-snapshot.service';
import {
  ExtractionHandler,
  EXTRACTION_EVENT_TYPES,
} from './core/adapters/extraction.handler';

// Ports & Adapters / Use Cases
import { ATTACHMENT_REPOSITORY_PORT } from './core/ports/attachment-repository.port';
import { PrismaAttachmentRepositoryAdapter } from './core/adapters/prisma-attachment-repository.adapter';
import { CreateAttachmentUseCase } from './core/use-cases/create-attachment.use-case';
import { DeleteAttachmentUseCase } from './core/use-cases/delete-attachment.use-case';

import { SetPrimaryAttachmentUseCase } from './core/use-cases/set-primary-attachment.use-case';
import { RenameAttachmentUseCase } from './core/use-cases/rename-attachment.use-case';
import { BatchRenameAttachmentsUseCase } from './core/use-cases/batch-rename-attachments.use-case';
import { GetAttachmentUseCase } from './core/use-cases/get-attachment.use-case';
import { GetItemAttachmentsUseCase } from './core/use-cases/get-item-attachments.use-case';

import { GetAttachmentThumbnailUseCase } from './core/use-cases/get-attachment-thumbnail.use-case';
import { ItemLifecycleSubscriber } from './core/adapters/item-lifecycle.subscriber';

// Annotation domain
import {
  AnnotationController,
  AnnotationsController,
} from './annotations.controller';
import {
  AnnotationService,
  AnnotationsService,
} from './core/use-cases/annotations.service';
import { AnnotationsRepository } from './core/adapters/annotations.repository';
import { AnnotationNormalizer } from './core/adapters/annotation.normalizer';
import { ANNOTATION_REPOSITORY_PORT } from './core/ports/annotation-repository.port';
import { PrismaAnnotationRepositoryAdapter } from './core/adapters/prisma-annotation-repository.adapter';
import { PdfAnnotationImporterService } from './core/adapters/pdf-annotation-importer.service';
import { CreateAnnotationUseCase } from './core/use-cases/create-annotation.use-case';
import { UpdateAnnotationUseCase } from './core/use-cases/update-annotation.use-case';
import { DeleteAnnotationUseCase } from './core/use-cases/delete-annotation.use-case';
import { BatchUpsertAnnotationsUseCase } from './core/use-cases/batch-upsert-annotations.use-case';
import { GetAnnotationUseCase } from './core/use-cases/get-annotation.use-case';
import { ListAnnotationsUseCase } from './core/use-cases/list-annotations.use-case';
import { CATALOG_GATEWAY_PORT } from './core/ports/catalog-gateway.port';
import { InProcessCatalogGatewayAdapter } from './core/adapters/in-process-catalog-gateway.adapter';

/**
 * Dedicated Extraction & Document Processing Hexagonal Module.
 * Parity with Manuscripts CLSI / Compute-heavy Microservice Architecture.
 *
 * Responsibilities:
 * - PDF Document Ingestion & Structure Layout Analysis (GROBID)
 * - Tesseract OCR Multithreaded Worker Pool with Watchdog Recycling
 * - Searchable Sandwich PDF Generation (Hidden text layer insertion)
 * - Object Storage Claim-Check Offloading (Gzip compression to S3)
 * - File Attachment Lifecycle & Multi-version Revisions
 * - Annotation Domain (PDF highlights, comments — moved from Catalog)
 */
@Module({
  imports: [CoreModule, StorageModule, SyncModule],
  controllers: [AttachmentController, AnnotationController],
  providers: [
    // Facades
    ExtractionFacade,
    {
      provide: EXTRACTION_FACADE,
      useExisting: ExtractionFacade,
    },
    {
      provide: READER_FACADE,
      useExisting: ExtractionFacade,
    },
    {
      provide: CONTENT_FACADE,
      useExisting: ExtractionFacade,
    },

    AttachmentsRepository,
    ExtractionRepository,
    AttachmentsService,
    WebSnapshotService,
    OcrPreprocessorService,
    OcrWorkerPoolService,
    OcrSandwichPdfService,
    OcrProvider,
    PdfProvider,
    ExtractionHandler,
    PrismaAttachmentRepositoryAdapter,
    {
      provide: ATTACHMENT_REPOSITORY_PORT,
      useClass: PrismaAttachmentRepositoryAdapter,
    },
    CreateAttachmentUseCase,
    DeleteAttachmentUseCase,
    SetPrimaryAttachmentUseCase,
    RenameAttachmentUseCase,
    BatchRenameAttachmentsUseCase,
    GetAttachmentUseCase,
    GetItemAttachmentsUseCase,
    GetAttachmentThumbnailUseCase,
    ItemLifecycleSubscriber,

    // Annotation domain providers
    AnnotationsService,
    AnnotationsRepository,
    AnnotationNormalizer,
    PrismaAnnotationRepositoryAdapter,
    {
      provide: ANNOTATION_REPOSITORY_PORT,
      useClass: PrismaAnnotationRepositoryAdapter,
    },
    PdfAnnotationImporterService,
    CreateAnnotationUseCase,
    UpdateAnnotationUseCase,
    DeleteAnnotationUseCase,
    BatchUpsertAnnotationsUseCase,
    GetAnnotationUseCase,
    ListAnnotationsUseCase,
    InProcessCatalogGatewayAdapter,
    {
      provide: CATALOG_GATEWAY_PORT,
      useClass: InProcessCatalogGatewayAdapter,
    },
  ],
  exports: [
    ExtractionFacade,
    EXTRACTION_FACADE,
    READER_FACADE,
    CONTENT_FACADE,
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
    CreateAttachmentUseCase,
    GetItemAttachmentsUseCase,
    GetAttachmentUseCase,

    // Annotation domain exports
    AnnotationsController,
    AnnotationsService,
    AnnotationNormalizer,
    ANNOTATION_REPOSITORY_PORT,
    PdfAnnotationImporterService,
    CreateAnnotationUseCase,
    UpdateAnnotationUseCase,
    DeleteAnnotationUseCase,
    BatchUpsertAnnotationsUseCase,
    GetAnnotationUseCase,
    ListAnnotationsUseCase,
  ],
})
export class ExtractionModule implements OnModuleInit {
  constructor(
    private readonly outboxWorker: OutboxWorker,
    private readonly extractionHandler: ExtractionHandler,
  ) {}

  onModuleInit() {
    this.outboxWorker.registerHandler(
      EXTRACTION_EVENT_TYPES.EXTRACTION_REQUESTED,
      this.extractionHandler,
    );
  }
}

export { AttachmentsController, AnnotationsController };
