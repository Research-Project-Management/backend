import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { PrismaService } from '../../../../core/database/prisma.service';
import { ExtractorService } from '../providers/extractor.provider';
import { FullTextIndexer } from '../../search/providers/full-text-indexer.provider';
import { STORAGE_PORT, IStoragePort } from '../../../storage/storage.port';
import { OutboxEvent } from '@prisma/client';
import { OutboxDispatchHandler } from '../../sync/outbox.worker';
import { AttachmentStorageException } from '../errors/attachments.errors';

export const EXTRACTION_EVENT_TYPES = {
  EXTRACTION_REQUESTED: 'library.attachment.extraction_requested',
} as const;

export const ATTACHMENT_EXTRACTION_STALE_THRESHOLD =
  'ATTACHMENT_EXTRACTION_STALE_THRESHOLD';

@Injectable()
export class AttachmentExtractionHandler implements OutboxDispatchHandler {
  private readonly logger = new Logger(AttachmentExtractionHandler.name);
  private readonly maxAttempts = 3;
  private readonly staleThresholdMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly extractorService: ExtractorService,
    private readonly fullTextIndexer: FullTextIndexer,
    @Inject(STORAGE_PORT) private readonly storagePort: IStoragePort,
    @Optional()
    @Inject(ATTACHMENT_EXTRACTION_STALE_THRESHOLD)
    staleThresholdMs?: number,
  ) {
    this.staleThresholdMs = staleThresholdMs ?? 5 * 60 * 1000;
  }

  async handle(event: OutboxEvent, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new Error(`Extraction aborted for outbox event ${event.id}`);
    }

    const payload = (event.payload as Record<string, any>) || {};
    const attachmentId = payload.attachmentId || event.aggregateId;

    if (!attachmentId) {
      this.logger.warn(
        `[AttachmentExtraction] Outbox event ${event.id} missing attachmentId`,
      );
      return;
    }

    // 1. Atomically claim PENDING / FAILED_RETRYABLE -> PROCESSING
    let claim = await this.prisma.catalogAttachment.updateMany({
      where: {
        id: attachmentId,
        extractionStatus: { in: ['PENDING', 'FAILED_RETRYABLE'] },
      },
      data: {
        extractionStatus: 'PROCESSING',
        extractionAttempts: { increment: 1 },
        extractionStartedAt: new Date(),
      },
    });

    // 2. If standard claim did not match, check for stale PROCESSING reclamation
    if (claim.count === 0) {
      const staleCutoff = new Date(Date.now() - this.staleThresholdMs);
      claim = await this.prisma.catalogAttachment.updateMany({
        where: {
          id: attachmentId,
          extractionStatus: 'PROCESSING',
          extractionStartedAt: { lt: staleCutoff },
        },
        data: {
          extractionStatus: 'PROCESSING',
          extractionAttempts: { increment: 1 },
          extractionStartedAt: new Date(),
        },
      });

      if (claim.count > 0) {
        this.logger.warn(
          JSON.stringify({
            event: 'library.attachment.extraction_stale_reclaimed',
            attachmentId,
            eventId: event.id,
          }),
        );
      }
    }

    if (claim.count === 0) {
      const existing = await this.prisma.catalogAttachment.findUnique({
        where: { id: attachmentId },
        select: { id: true, extractionStatus: true, extractionStartedAt: true },
      });

      if (!existing) {
        this.logger.warn(
          `[AttachmentExtraction] Attachment ${attachmentId} not found. Skipping.`,
        );
        return;
      }

      this.logger.debug(
        `[AttachmentExtraction] Attachment ${attachmentId} status is ${existing.extractionStatus} (claim count: 0). Skipping duplicate or active extraction.`,
      );
      return;
    }

    const attachment = await this.prisma.catalogAttachment.findUnique({
      where: { id: attachmentId },
      include: { file: true, catalogItem: true },
    });

    if (!attachment) {
      this.logger.warn(
        `[AttachmentExtraction] Attachment ${attachmentId} not found after claim. Skipping.`,
      );
      return;
    }

    this.logger.log(
      JSON.stringify({
        event: 'library.extraction.started',
        eventId: event.id,
        attachmentId,
        catalogItemId: attachment.catalogItemId,
      }),
    );

    try {
      const workspaceId =
        attachment.catalogItem?.workspaceId ||
        attachment.file?.workspaceId ||
        payload.workspaceId;
      const fileId = attachment.fileId || attachment.file?.id;

      if (!fileId || !workspaceId) {
        throw new AttachmentStorageException(
          `Could not resolve workspaceId or fileId for attachment ${attachmentId}`,
        );
      }

      // 2. Storage-first reading via Storage Port
      const storageFile = await this.storagePort.readOwnedFile({
        workspaceId,
        fileId,
      });
      const buffer = storageFile.buffer;

      if (!buffer) {
        throw new AttachmentStorageException(
          `Could not resolve binary buffer for attachment ${attachmentId}`,
        );
      }

      // 3. Extract text and per-page structures
      const doc = await this.extractorService.extractDocumentFromBuffer(buffer);

      // 4. Atomically index pages idempotently
      if (doc.pages.length > 0) {
        await this.fullTextIndexer.indexAttachmentPages(
          attachment.id,
          doc.pages,
        );
      }

      // 5. Update status to READY on completion
      await this.prisma.catalogAttachment.update({
        where: { id: attachment.id },
        data: {
          extractionStatus: 'READY',
          extractionCompletedAt: new Date(),
          extractionLastError: null,
        },
      });

      this.logger.log(
        JSON.stringify({
          event: 'library.extraction.completed',
          attachmentId,
          catalogItemId: attachment.catalogItemId,
          pageCount: doc.pages.length,
          hasMetadata: Boolean(doc.metadata.doi || doc.metadata.title),
        }),
      );
    } catch (err: any) {
      const updatedAttachment = await this.prisma.catalogAttachment.findUnique({
        where: { id: attachmentId },
        select: { extractionAttempts: true },
      });

      const currentAttempts = updatedAttachment?.extractionAttempts ?? 1;
      const isFinal = currentAttempts >= this.maxAttempts;
      const nextStatus = isFinal ? 'FAILED_FINAL' : 'FAILED_RETRYABLE';
      const sanitizedError = String(err?.message ?? 'Extraction error').slice(
        0,
        500,
      );

      await this.prisma.catalogAttachment.update({
        where: { id: attachment.id },
        data: {
          extractionStatus: nextStatus,
          extractionLastError: sanitizedError,
          ...(isFinal ? { extractionCompletedAt: new Date() } : {}),
        },
      });

      this.logger.error(
        JSON.stringify({
          event: 'library.extraction.failed',
          attachmentId,
          catalogItemId: attachment.catalogItemId,
          attempts: currentAttempts,
          status: nextStatus,
          error: sanitizedError,
        }),
      );

      throw err; // Re-throw to allow outbox worker to manage retry / dead-lettering
    }
  }
}
