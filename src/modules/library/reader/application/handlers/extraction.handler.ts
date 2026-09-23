import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import crypto from 'crypto';
import { ExtractionRepository } from '../../infrastructure/repositories/extraction.repository';
import { PdfProvider } from '../../infrastructure/providers/pdf.provider';
import { STORAGE_PORT, IStoragePort } from '@/modules/storage/storage.port';
import { OutboxEvent, Prisma } from '@prisma/client';
import { OutboxDispatchHandler } from '../../../shared-kernel/outbox/types/outbox.types';
import { AttachmentStorageException } from '../../domain/errors/attachments.errors';
import { parseCreatorString } from '../../../shared-kernel/utils/bibliographic.utils';

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
  private readonly storagePort: IStoragePort;
  private readonly searchService?: any;

  constructor(
    private readonly extractionRepo: ExtractionRepository,
    private readonly pdf: PdfProvider,
    @Inject(STORAGE_PORT) storagePortOrSearch: any,
    @Optional() storagePortCandidate?: any,
    @Optional()
    @Inject(ATTACHMENT_EXTRACTION_STALE_THRESHOLD)
    staleThresholdMs?: number,
  ) {
    if (
      storagePortOrSearch &&
      typeof storagePortOrSearch.readOwnedFile === 'function'
    ) {
      this.storagePort = storagePortOrSearch;
      this.searchService = storagePortCandidate;
    } else if (
      storagePortCandidate &&
      typeof storagePortCandidate.readOwnedFile === 'function'
    ) {
      this.searchService = storagePortOrSearch;
      this.storagePort = storagePortCandidate;
    } else {
      this.storagePort = storagePortOrSearch;
      this.searchService = storagePortCandidate;
    }
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
    let claim = await this.extractionRepo.claimPendingOrRetryable(attachmentId);

    // 2. If standard claim did not match, check for stale PROCESSING reclamation
    if (claim.count === 0) {
      const staleCutoff = new Date(Date.now() - this.staleThresholdMs);
      claim = await this.extractionRepo.claimStaleProcessing(
        attachmentId,
        staleCutoff,
      );

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
      const existing = await this.extractionRepo.findUniqueAttachment(
        attachmentId,
        {
          select: {
            id: true,
            extractionStatus: true,
            extractionStartedAt: true,
          },
        },
      );

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

    const attachment = await this.extractionRepo.findUniqueAttachment(
      attachmentId,
      {
        include: { item: true },
      },
    );

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
      const fileId =
        attachment.fileId ||
        attachment.url?.match(
          /\/api\/(?:v1\/(?:projects\/[^/]+\/)?library\/)?(?:attachments\/)?files\/([a-zA-Z0-9_-]+)/,
        )?.[1];

      if (!fileId) {
        throw new AttachmentStorageException(
          `Could not resolve fileId for attachment ${attachmentId}`,
        );
      }

      if (!attachment.fileId) {
        await this.extractionRepo
          .updateAttachmentFileId(attachment.id, fileId)
          .catch(() => {});
      }

      // 2. Storage-first reading via Storage Port
      const storageFile = await this.storagePort.readOwnedFile({
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

      // 4.1. Store OCR provenance and quality stats if any pages were OCR'd
      if (doc.ocrProvenance && doc.ocrProvenance.totalOcrPages > 0) {
        try {
          await this.extractionRepo.saveMetadataSourceRecord(
            attachment.itemId,
            'ocr_provenance',
            doc.ocrProvenance as any,
          );

          const existingMeta =
            (attachment.metadata as Record<string, any>) || {};
          await this.extractionRepo.updateAttachmentMetadata(attachment.id, {
            ...existingMeta,
            ocr: {
              totalOcrPages: doc.ocrProvenance.totalOcrPages,
              avgConfidence: doc.ocrProvenance.avgConfidence,
              executionTimeMs: doc.ocrProvenance.executionTimeMs,
            },
          });
        } catch (ocrErr: any) {
          this.logger.warn(
            `Failed to save OCR provenance: ${ocrErr?.message || ocrErr}`,
          );
        }
      }

      // 4.2. Persist Searchable Sandwich PDF and create revision if OCR produced one
      if (
        doc.searchablePdfBuffer &&
        doc.ocrProvenance &&
        doc.ocrProvenance.totalOcrPages > 0 &&
        typeof this.storagePort?.uploadFile === 'function'
      ) {
        try {
          const ownerUserId = attachment.item?.userId || 'system';
          const ownerProjectId = attachment.item?.projectId || undefined;
          const originalFilename = attachment.filename || 'document.pdf';
          const uploadResult = await this.storagePort.uploadFile({
            userId: ownerUserId,
            projectId: ownerProjectId,
            filename: originalFilename.toLowerCase().endsWith('.pdf')
              ? originalFilename
              : `${originalFilename}.pdf`,
            buffer: doc.searchablePdfBuffer,
            mimeType: 'application/pdf',
            source: 'reader.ocr_sandwich',
          });

          if (uploadResult?.fileId) {
            const hash = crypto
              .createHash('sha256')
              .update(doc.searchablePdfBuffer)
              .digest('hex');

            await this.extractionRepo.recordSearchablePdfRevision({
              attachmentId: attachment.id,
              fileId: uploadResult.fileId,
              url: uploadResult.url,
              sizeBytes: BigInt(doc.searchablePdfBuffer.length),
              fileHash: hash,
              comment: `OCR Sandwich PDF (${doc.ocrProvenance.totalOcrPages} pages recognized, avg confidence ${doc.ocrProvenance.avgConfidence}%)`,
            });

            this.logger.log(
              `[AttachmentExtraction] Successfully saved searchable OCR Sandwich PDF for attachment ${attachment.id} (new fileId: ${uploadResult.fileId})`,
            );
          }
        } catch (sandwichErr: any) {
          this.logger.warn(
            `Failed to persist searchable sandwich PDF for attachment ${attachment.id}: ${sandwichErr?.message || sandwichErr}`,
          );
        }
      }

      // 5. Store authoritative GROBID ML extraction provenance & full-text tree
      if (
        doc.metadata?.rawTei ||
        (doc.references && doc.references.length > 0) ||
        (doc.sections && doc.sections.length > 0)
      ) {
        try {
          // Store full-text structured tree (sections, figures, tables, formulas)
          await this.extractionRepo.saveMetadataSourceRecord(
            attachment.itemId,
            'grobid_fulltext',
            {
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
          );

          // Also keep grobid metadata provenance record for backward compatibility
          await this.extractionRepo.saveMetadataSourceRecord(
            attachment.itemId,
            'grobid',
            {
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
          );

          // Synchronize extracted referenceCount & core metadata onto the Item model
          const currentTitle = String(attachment.item?.title || '').trim();
          const shouldUpdateTitle =
            doc.metadata?.title &&
            (!currentTitle ||
              currentTitle === 'Untitled Document' ||
              currentTitle === 'Uploaded Document' ||
              /\.pdf$/i.test(currentTitle) ||
              /^10\.\d{4,9}\//.test(currentTitle));

          const itemPatch: Prisma.ItemUpdateInput = {
            ...(doc.references && doc.references.length > 0
              ? { referenceCount: doc.references.length }
              : {}),
            ...(shouldUpdateTitle ? { title: doc.metadata.title } : {}),
            ...(!attachment.item?.doi && doc.metadata?.doi
              ? { doi: doc.metadata.doi }
              : {}),
            ...(!attachment.item?.arxivId && doc.metadata?.arxivId
              ? { arxivId: doc.metadata.arxivId }
              : {}),
            ...(!attachment.item?.abstract && doc.metadata?.abstract
              ? { abstract: doc.metadata.abstract }
              : {}),
            ...(!attachment.item?.year && doc.metadata?.year
              ? { year: doc.metadata.year }
              : {}),
            ...(!attachment.item?.publicationTitle && doc.metadata?.journal
              ? {
                  publicationTitle: doc.metadata.journal,
                }
              : {}),
          };

          if (Object.keys(itemPatch).length > 0) {
            await this.extractionRepo.updateItem(attachment.itemId, itemPatch);
          }

          if (doc.metadata?.creators && doc.metadata.creators.length > 0) {
            const count = await this.extractionRepo.countContributors(
              attachment.itemId,
            );
            if (count === 0) {
              await this.extractionRepo.createContributors(
                doc.metadata.creators.map((c, idx) => {
                  const creatorType = 'author';
                  const parsed = parseCreatorString(
                    c.fullName ||
                      `${c.firstName || ''} ${c.lastName || ''}`.trim(),
                    idx,
                    creatorType,
                  );
                  const first = c.firstName || parsed.firstName || '';
                  const last = c.lastName || parsed.lastName || '';
                  const full =
                    c.fullName ||
                    parsed.fullName ||
                    [first, last].filter(Boolean).join(' ') ||
                    '';
                  return {
                    itemId: attachment.itemId,
                    orderIndex: idx,
                    creatorType,
                    firstName: first,
                    lastName: last,
                    fullName: full,
                  };
                }),
              );
            }
          }
        } catch (provenanceErr: any) {
          this.logger.debug(
            `Could not store GROBID provenance: ${provenanceErr?.message}`,
          );
        }
      }

      const scopeId =
        attachment.item?.projectId ||
        attachment.item?.userId ||
        payload.projectId ||
        payload.userId;

      // 6. Build in-library citation graph (match references against papers in same project scope)
      if (doc.references && doc.references.length > 0 && scopeId) {
        try {
          await this.linkInLibraryCitations(
            scopeId,
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
      await this.extractionRepo.markReady(attachment.id);

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
      const updatedAttachment = await this.extractionRepo.findUniqueAttachment(
        attachmentId,
        {
          select: { extractionAttempts: true },
        },
      );

      const currentAttempts = updatedAttachment?.extractionAttempts ?? 1;
      const isFinal = currentAttempts >= this.maxAttempts;
      const nextStatus = isFinal ? 'FAILED_FINAL' : 'FAILED_RETRYABLE';
      const sanitizedError = String(err?.message ?? 'Extraction error').slice(
        0,
        500,
      );

      await this.extractionRepo.markFailed(
        attachment.id,
        nextStatus,
        sanitizedError,
        isFinal,
      );

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
   * Matches extracted bibliographic references against other papers in the same scope.
   * Automatically establishes in-library citation edges ('cites') in item_relations.
   */
  public async linkInLibraryCitations(
    scopeId: string,
    sourceItemId: string,
    references: Array<{ title?: string; doi?: string; arxivId?: string }>,
  ): Promise<void> {
    const scopePapers = await this.extractionRepo.findScopePapers(
      scopeId,
      sourceItemId,
    );

    if (scopePapers.length === 0) return;

    const doiMap = new Map<string, string>();
    const titleMap = new Map<string, string>();

    const normalizeTitle = (t: string) =>
      t
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
        .trim();

    for (const p of scopePapers) {
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
          await this.extractionRepo.upsertItemCitationRelation(
            sourceItemId,
            targetItemId,
            ref.title || 'Cited in document bibliography',
          );
        } catch {
          // Ignore unique conflicts or transient race conditions
        }
      }
    }
  }
}

export { ExtractionHandler as AttachmentExtractionHandler };
