import { Module, OnModuleInit } from '@nestjs/common';
import { CoreModule } from '../../../core/core.module';
import { SharedKernelModule } from '../shared-kernel/shared-kernel.module';
import { OutboxWorker } from '../shared-kernel/outbox/outbox.worker';
import { StorageModule } from '../../storage/storage.module';
import { BibliographyModule } from '../bibliography/bibliography.module';

// Facade
import {
  ReaderFacade,
  READER_FACADE,
  ContentFacade,
  CONTENT_FACADE,
} from './reader.facade';

// ── 1. Attachments ────────────────────────────────────────────────────────
import { AttachmentsController } from './presentation/attachments.controller';
import { AttachmentsService } from './application/services/attachments.service';
import { AttachmentsRepository } from './infrastructure/repositories/attachments.repository';
import { ExtractionRepository } from './infrastructure/repositories/extraction.repository';
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
import { DeleteAttachmentUseCase } from './application/commands/delete-attachment.use-case';
import { AddAttachmentRevisionUseCase } from './application/commands/add-attachment-revision.use-case';
import { SetPrimaryAttachmentUseCase } from './application/commands/set-primary-attachment.use-case';
import { RenameAttachmentUseCase } from './application/commands/rename-attachment.use-case';
import { BatchRenameAttachmentsUseCase } from './application/commands/batch-rename-attachments.use-case';
import { GetAttachmentUseCase } from './application/queries/get-attachment.use-case';
import { GetItemAttachmentsUseCase } from './application/queries/get-item-attachments.use-case';
import { GetAttachmentRevisionsUseCase } from './application/queries/get-attachment-revisions.use-case';
import { GetAttachmentThumbnailUseCase } from './application/queries/get-attachment-thumbnail.use-case';
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
import { NOTE_REPOSITORY_PORT } from './domain/ports/note-repository.port';
import { PrismaNoteRepositoryAdapter } from './infrastructure/adapters/prisma-note-repository.adapter';

/**
 * Reader Bounded Context Unified Module (Supporting Domain).
 *
 * Consolidates all reader features into a single Clean Architecture module:
 * - Attachments (Uploads, OCR, Snapshots, Storage, Extraction)
 * - Annotations (Highlights, Comments, PDF importer, Ports/Adapters)
 * - Notes (Markdown/Rich notes, Optimistic locking, Ports/Adapters)
 */
@Module({
  imports: [CoreModule, SharedKernelModule, StorageModule, BibliographyModule],
  controllers: [AttachmentsController, AnnotationsController, NotesController],
  providers: [
    // Facade
    ReaderFacade,
    {
      provide: READER_FACADE,
      useExisting: ReaderFacade,
    },
    {
      provide: CONTENT_FACADE,
      useExisting: ReaderFacade,
    },

    // ── Attachments Providers ──────────────────────────────────────────
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
    AddAttachmentRevisionUseCase,
    SetPrimaryAttachmentUseCase,
    RenameAttachmentUseCase,
    BatchRenameAttachmentsUseCase,
    GetAttachmentUseCase,
    GetItemAttachmentsUseCase,
    GetAttachmentRevisionsUseCase,
    GetAttachmentThumbnailUseCase,
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
    PrismaNoteRepositoryAdapter,
    {
      provide: NOTE_REPOSITORY_PORT,
      useClass: PrismaNoteRepositoryAdapter,
    },
  ],
  exports: [
    // Facade
    ReaderFacade,
    READER_FACADE,
    ContentFacade,
    CONTENT_FACADE,

    // Ports
    ATTACHMENT_REPOSITORY_PORT,
    ANNOTATION_REPOSITORY_PORT,
    NOTE_REPOSITORY_PORT,

    // Use Cases
    CreateAttachmentUseCase,
    DeleteAttachmentUseCase,
    AddAttachmentRevisionUseCase,
    SetPrimaryAttachmentUseCase,
    RenameAttachmentUseCase,
    BatchRenameAttachmentsUseCase,
    GetAttachmentUseCase,
    GetItemAttachmentsUseCase,
    GetAttachmentRevisionsUseCase,
    GetAttachmentThumbnailUseCase,
  ],
})
export class ReaderModule implements OnModuleInit {
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
