import { Module, OnModuleInit, forwardRef } from '@nestjs/common';
import { CoreModule } from '../../../core/core.module';
import { SharedKernelModule } from '../shared-kernel/shared-kernel.module';
import { OutboxWorker } from '../shared-kernel/outbox/outbox.worker';
import { StorageModule } from '../../storage/storage.module';
import { CatalogModule } from '../catalog/catalog.module';
import { DiscoveryModule } from '../discovery/discovery.module';

// Facade
import { ContentFacade, CONTENT_FACADE } from './content.facade';

// ── 1. Attachments ────────────────────────────────────────────────────────
import { AttachmentsController } from './presentation/attachments.controller';
import { AttachmentsService } from './application/services/attachments.service';
import { AttachmentsRepository } from './infrastructure/repositories/attachments.repository';
import { PdfProvider } from './infrastructure/providers/pdf.provider';
import { OcrProvider } from './infrastructure/providers/ocr.provider';
import { OcrPreprocessorService } from './infrastructure/ocr/ocr-preprocessor.service';
import { OcrWorkerPoolService } from './infrastructure/ocr/ocr-worker-pool.service';
import { OcrSandwichPdfService } from './infrastructure/ocr/ocr-sandwich-pdf.service';
import { WebSnapshotService } from './application/services/web-snapshot.service';
import {
  ExtractionHandler,
  EXTRACTION_EVENT_TYPES,
} from './application/handlers/extraction.handler';

// Clean Architecture — Attachment Port & Use Cases
import { ATTACHMENT_REPOSITORY_PORT } from './domain/ports/attachment-repository.port';
import { PrismaAttachmentRepositoryAdapter } from './infrastructure/adapters/prisma-attachment-repository.adapter';
import { CreateAttachmentUseCase } from './application/commands/create-attachment.use-case';
import { GetAttachmentUseCase } from './application/queries/get-attachment.use-case';
import { ItemLifecycleSubscriber } from './infrastructure/subscribers/item-lifecycle.subscriber';

// ── 2. Annotations ────────────────────────────────────────────────────────
import { AnnotationsController } from './presentation/annotations.controller';
import { AnnotationsService } from './application/services/annotations.service';
import { AnnotationsRepository } from './infrastructure/repositories/annotations.repository';
import { AnnotationNormalizer } from './application/normalizers/annotation.normalizer';
import { PdfAnnotationImporterService } from './application/services/pdf-annotation-importer.service';
import { ANNOTATION_REPOSITORY_PORT } from './domain/ports/annotation-repository.port';
import { PrismaAnnotationRepositoryAdapter } from './infrastructure/adapters/prisma-annotation-repository.adapter';

// ── 3. Notes ──────────────────────────────────────────────────────────────
import { NotesController } from './presentation/notes.controller';
import { NotesService } from './application/services/notes.service';
import { NotesRepository } from './infrastructure/repositories/notes.repository';
import { ITEM_NOTES_EXTRACTOR_PORT } from '../catalog/domain/ports/items.ports';
import { NOTE_REPOSITORY_PORT } from './domain/ports/note-repository.port';
import { PrismaNoteRepositoryAdapter } from './infrastructure/adapters/prisma-note-repository.adapter';

/**
 * Content Bounded Context Unified Module (Supporting Domain).
 *
 * Consolidates all content features into a single Clean Architecture module:
 * - Attachments (Uploads, OCR, Snapshots, Storage, Extraction)
 * - Annotations (Highlights, Comments, PDF importer, Ports/Adapters)
 * - Notes (Markdown/Rich notes, Optimistic locking, Ports/Adapters)
 */
@Module({
  imports: [
    CoreModule,
    SharedKernelModule,
    StorageModule,
    forwardRef(() => CatalogModule),
    forwardRef(() => DiscoveryModule),
  ],
  controllers: [AttachmentsController, AnnotationsController, NotesController],
  providers: [
    // Facade
    ContentFacade,
    {
      provide: CONTENT_FACADE,
      useExisting: ContentFacade,
    },

    // ── Attachments Providers ──────────────────────────────────────────
    AttachmentsRepository,
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
    GetAttachmentUseCase,
    ItemLifecycleSubscriber,

    // ── Annotations Providers ──────────────────────────────────────────
    AnnotationsRepository,
    AnnotationsService,
    AnnotationNormalizer,
    PdfAnnotationImporterService,
    PrismaAnnotationRepositoryAdapter,
    {
      provide: ANNOTATION_REPOSITORY_PORT,
      useClass: PrismaAnnotationRepositoryAdapter,
    },

    // ── Notes Providers ────────────────────────────────────────────────
    NotesRepository,
    NotesService,
    {
      provide: ITEM_NOTES_EXTRACTOR_PORT,
      useExisting: NotesService,
    },
    PrismaNoteRepositoryAdapter,
    {
      provide: NOTE_REPOSITORY_PORT,
      useClass: PrismaNoteRepositoryAdapter,
    },
  ],
  exports: [
    // Facade
    ContentFacade,
    CONTENT_FACADE,

    // Ports
    ATTACHMENT_REPOSITORY_PORT,
    ANNOTATION_REPOSITORY_PORT,
    NOTE_REPOSITORY_PORT,
    ITEM_NOTES_EXTRACTOR_PORT,
  ],

})
export class ContentModule implements OnModuleInit {
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
