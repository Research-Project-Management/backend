import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { PrismaService } from '../../../../core/database/prisma.service';
import { PdfProvider } from '../providers/pdf.provider';
import { SearchService } from '../../search/search.service';
import { STORAGE_PORT, IStoragePort } from '../../../storage/storage.port';
import { OutboxEvent } from '@prisma/client';
import { OutboxDispatchHandler } from '../../outbox/types/outbox.types';
import { AttachmentStorageException } from '../errors/attachments.errors';

export const EXTRACTION_EVENT_TYPES = {
  EXTRACTION_REQUESTED: 'library.attachment.extraction_requested',
} as const;

export const ATTACHMENT_EXTRACTION_STALE_THRESHOLD =
  'ATTACHMENT_EXTRACTION_STALE_THRESHOLD';

@Injectable()
export class ExtractionHandler implements OutboxDispatchHandler {
  private readonly logger = new Logger(ExtractionHandler.name);
  private readonly maxAttempts = 3;
  private readonly staleThresholdMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly pdf: PdfProvider,
    private readonly searchService: SearchService,
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
    let claim = await this.prisma.attachment.updateMany({
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
      claim = await this.prisma.attachment.updateMany({
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
      const existing = await this.prisma.attachment.findUnique({
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

    const attachment = await this.prisma.attachment.findUnique({
      where: { id: attachmentId },
      include: { file: true, item: true },
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
        itemId: attachment.itemId,
      }),
    );

    try {
      const workspaceId =
        attachment.item?.workspaceId ||
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
      const doc = await this.pdf.extractDocumentFromBuffer(buffer);

      // 4. Atomically index pages idempotently
      if (doc.pages.length > 0) {
        await this.searchService.indexAttachmentPages(attachment.id, doc.pages);
      }

      // 5. Store authoritative GROBID ML extraction provenance & full-text tree
      if (
        doc.metadata?.rawTei ||
        (doc.references && doc.references.length > 0) ||
        (doc.sections && doc.sections.length > 0)
      ) {
        try {
          // Store full-text structured tree (sections, figures, tables, formulas)
          await this.prisma.metadataSourceRecord.create({
            data: {
              itemId: attachment.itemId,
              sourceProvider: 'grobid_fulltext',
              confidenceScore: 1.0,
              rawPayload: {
                title: doc.metadata.title,
                abstract: doc.metadata.abstract,
                creators: doc.metadata.creators,
                doi: doc.metadata.doi,
                arxivId: doc.metadata.arxivId,
                year: doc.metadata.year,
                keywords: doc.metadata.keywords,
                sections: doc.sections ?? [],
                figures: doc.figures ?? [],
                tables: doc.tables ?? [],
                formulas: doc.formulas ?? [],
                references: doc.references ?? [],
                sectionCount: doc.sections?.length ?? 0,
                figureCount: doc.figures?.length ?? 0,
                tableCount: doc.tables?.length ?? 0,
                formulaCount: doc.formulas?.length ?? 0,
                referenceCount: doc.references?.length ?? 0,
              } as any,
            },
          });

          // Also keep grobid metadata provenance record for backward compatibility
          await this.prisma.metadataSourceRecord.create({
            data: {
              itemId: attachment.itemId,
              sourceProvider: 'grobid',
              confidenceScore: 1.0,
              rawPayload: {
                title: doc.metadata.title,
                abstract: doc.metadata.abstract,
                creators: doc.metadata.creators,
                doi: doc.metadata.doi,
                arxivId: doc.metadata.arxivId,
                year: doc.metadata.year,
                keywords: doc.metadata.keywords,
                referenceCount: doc.references?.length ?? 0,
                references: doc.references ?? [],
              } as any,
            },
          });
        } catch (provenanceErr: any) {
          this.logger.debug(
            `Could not store GROBID provenance: ${provenanceErr?.message}`,
          );
        }
      }

      // 6. Build in-library citation graph (match references against papers in same workspace)
      if (doc.references && doc.references.length > 0) {
        try {
          await this.linkInLibraryCitations(
            workspaceId,
            attachment.itemId,
            doc.references,
          );
        } catch (linkErr: any) {
          this.logger.warn(
            `In-library citation linking warning: ${linkErr?.message}`,
          );
        }
      }

      // 7. Update status to READY on completion
      await this.prisma.attachment.update({
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
          itemId: attachment.itemId,
          pageCount: doc.pages.length,
          referenceCount: doc.references?.length ?? 0,
          hasMetadata: Boolean(doc.metadata.doi || doc.metadata.title),
        }),
      );
    } catch (err: any) {
      const updatedAttachment = await this.prisma.attachment.findUnique({
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

      await this.prisma.attachment.update({
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
          itemId: attachment.itemId,
          attempts: currentAttempts,
          status: nextStatus,
          error: sanitizedError,
        }),
      );

      throw err; // Re-throw to allow outbox worker to manage retry / dead-lettering
    }
  }

  /**
   * Matches extracted bibliographic references against other papers in the same workspace.
   * Automatically establishes in-library citation edges ('cites') in item_relations.
   */
  private async linkInLibraryCitations(
    workspaceId: string,
    sourceItemId: string,
    references: Array<{ title?: string; doi?: string; arxivId?: string }>,
  ): Promise<void> {
    const workspacePapers = await this.prisma.item.findMany({
      where: {
        workspaceId,
        id: { not: sourceItemId },
        deletedAt: null,
      },
      select: {
        id: true,
        title: true,
        doi: true,
      },
    });

    if (workspacePapers.length === 0) return;

    const doiMap = new Map<string, string>();
    const titleMap = new Map<string, string>();

    const normalizeTitle = (t: string) =>
      t
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
        .trim();

    for (const p of workspacePapers) {
      if (p.doi) {
        doiMap.set(p.doi.toLowerCase().trim(), p.id);
      }
      if (p.title && p.title.length > 10) {
        titleMap.set(normalizeTitle(p.title), p.id);
      }
    }

    for (const ref of references) {
      let targetItemId: string | undefined;

      if (ref.doi) {
        targetItemId = doiMap.get(ref.doi.toLowerCase().trim());
      }

      if (!targetItemId && ref.title && ref.title.length > 10) {
        targetItemId = titleMap.get(normalizeTitle(ref.title));
      }

      if (targetItemId && targetItemId !== sourceItemId) {
        try {
          await this.prisma.itemRelation.upsert({
            where: {
              sourceItemId_targetItemId_relationType: {
                sourceItemId,
                targetItemId,
                relationType: 'cites',
              },
            },
            update: {},
            create: {
              workspaceId,
              sourceItemId,
              targetItemId,
              relationType: 'cites',
              description: ref.title || 'Cited in document bibliography',
            },
          });
        } catch {
          // Ignore unique conflicts or transient race conditions
        }
      }
    }
  }
}

export { ExtractionHandler as AttachmentExtractionHandler };
