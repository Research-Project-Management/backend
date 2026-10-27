import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import crypto from 'crypto';
import { ExtractionRepository } from '@/modules/library/extraction/repositories/extraction.repository';
import { PdfProvider } from '@/modules/library/extraction/providers/pdf.provider';
import { STORAGE_PORT, IStoragePort } from '@/modules/storage/storage.port';
import { OutboxEvent, Prisma } from '@prisma/client';
import {
  OutboxDispatchHandler,
  LIBRARY_EVENT_TYPES,
  normalizeProjectScopeId,
  extractFileIdFromUrl,
  ExtractionProcessException,
} from '@/modules/library/core';
import {
  IdempotentConsumerService,
  TransactionService,
} from '@/modules/library/sync';
import { AttachmentStorageException } from '@/modules/library/extraction/types/attachments.types';
import { RedisCacheService } from '@/core';
import { LIBRARY_REDIS_KEYS } from '@/modules/library/core/constants/redis-keys.constants';
import { ItemCacheCoordinator } from '@/modules/library/catalog';
import { ReferenceMatcherService } from './reference-matcher.service';
import { ExtractionMetadataSynchronizer } from './extraction-metadata.synchronizer';

export const EXTRACTION_EVENT_TYPES = {
  EXTRACTION_REQUESTED: 'library.attachment.extraction_requested',
  PAGES_EXTRACTED: 'library.attachment.pages.extracted',
} as const;

@Injectable()
export class ExtractionHandler implements OutboxDispatchHandler {
  private readonly logger = new Logger(ExtractionHandler.name);
  private readonly maxAttempts = 3;
  private readonly staleThresholdMs = 5 * 60 * 1000;
  private readonly metadataSync: ExtractionMetadataSynchronizer;

  constructor(
    private readonly extractionRepo: ExtractionRepository,
    private readonly pdf: PdfProvider,
    @Inject(STORAGE_PORT) private readonly storagePort: IStoragePort,
    @Optional()
    private readonly idempotentConsumer?: IdempotentConsumerService,
    @Optional()
    private readonly cache?: RedisCacheService,
    @Optional()
    private readonly referenceMatcher?: ReferenceMatcherService,
    @Optional()
    private readonly eventEmitter?: EventEmitter2,
    @Optional()
    private readonly libraryTx?: TransactionService,
    @Optional()
    @Inject('SEARCH_FACADE')
    private readonly searchFacade?: {
      indexAttachmentPages?: (
        attachmentId: string,
        pages: Array<{
          pageIndex: number;
          textContent: string;
          charOffset?: number;
        }>,
      ) => Promise<void>;
    },
    @Optional()
    metadataSync?: ExtractionMetadataSynchronizer,
    @Optional()
    private readonly cacheCoordinator?: ItemCacheCoordinator,
  ) {
    this.metadataSync =
      metadataSync ??
      new ExtractionMetadataSynchronizer(
        this.extractionRepo,
        this.libraryTx,
        this.storagePort,
        this.cacheCoordinator,
      );
  }

  async handle(event: OutboxEvent, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new ExtractionProcessException(
        `Extraction aborted for outbox event ${event.id}`,
        { eventId: event.id },
      );
    }

    const payload = (event.payload as Record<string, unknown>) || {};
    const attachmentId =
      (typeof payload.attachmentId === 'string'
        ? payload.attachmentId
        : undefined) || event.aggregateId;

    if (!attachmentId) {
      this.logger.warn(
        `[AttachmentExtraction] Outbox event ${event.id} missing attachmentId`,
      );
      return;
    }

    if (this.idempotentConsumer) {
      const execResult = await this.idempotentConsumer.executeIdempotent({
        consumer: 'ExtractionHandler',
        eventId: event.id,
        handler: async () => {
          await this.processExtraction(event, attachmentId, payload, signal);
        },
      });

      if (execResult.skipped) {
        if (execResult.reason === 'IN_FLIGHT') {
          throw new ExtractionProcessException(
            `Extraction in-flight for event ${event.id}; retrying later`,
            { eventId: event.id, attachmentId },
          );
        }
        this.logger.debug(
          `[AttachmentExtraction] Skipping already completed extraction for event ${event.id} (${execResult.reason})`,
        );
        return;
      }
      return;
    }

    await this.processExtraction(event, attachmentId, payload, signal);
  }

  private async processExtraction(
    event: OutboxEvent,
    attachmentId: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) {
      throw new ExtractionProcessException(
        `Extraction aborted for outbox event ${event.id}`,
        { eventId: event.id, attachmentId },
      );
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

      if (existing.extractionStatus === 'PROCESSING') {
        throw new ExtractionProcessException(
          `Attachment ${attachmentId} is currently PROCESSING; retrying later`,
          { eventId: event.id, attachmentId },
        );
      }
      this.logger.debug(
        `[AttachmentExtraction] Attachment ${attachmentId} status is ${existing.extractionStatus} (claim count: 0). Skipping redundant extraction.`,
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
      const fileId = attachment.fileId || extractFileIdFromUrl(attachment.url);

      if (!fileId) {
        throw new AttachmentStorageException(
          `Could not resolve fileId for attachment ${attachmentId}`,
        );
      }

      if (!attachment.fileId) {
        await this.extractionRepo
          .updateAttachmentFileId(attachment.id, fileId)
          .catch((err: unknown) => {
            this.logger.warn(
              `Failed to backfill attachment fileId for ${attachment.id}: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
      }

      // 2. Storage-first reading via Storage Port
      const storageFile = await this.storagePort.readOwnedFile({
        fileId,
        userId: attachment.item?.userId,
        projectId: attachment.item?.projectId ?? undefined,
      });
      const rawBuffer =
        storageFile?.buffer ||
        (Buffer.isBuffer(storageFile) ? storageFile : null);

      if (!rawBuffer) {
        throw new AttachmentStorageException(
          `Could not resolve binary buffer for attachment ${attachmentId}`,
        );
      }

      const buffer: Buffer = Buffer.isBuffer(rawBuffer)
        ? rawBuffer
        : typeof rawBuffer === 'string'
          ? Buffer.from(rawBuffer)
          : Buffer.from(rawBuffer as ArrayBuffer);

      // 3. Extract text and per-page structures
      if (signal?.aborted) {
        throw new ExtractionProcessException(
          `Extraction aborted due to lost lease before PDF parsing for attachment ${attachmentId}`,
          { eventId: event.id, attachmentId },
        );
      }
      const doc = await this.pdf.extractDocumentFromBuffer(buffer);
      if (signal?.aborted) {
        throw new ExtractionProcessException(
          `Extraction aborted due to lost lease after PDF parsing for attachment ${attachmentId}`,
          { eventId: event.id, attachmentId },
        );
      }
      const extractionResult = doc as Omit<typeof doc, 'pages'> & {
        markdown?: string;
        text?: string;
        pageCount?: number;
        pages?: Array<{
          pageIndex?: number;
          pageNumber?: number;
          textContent?: string;
          text?: string;
          charOffset?: number;
        }>;
      };

      // 3.1. Wire Page-Level FullText Indexing (FullTextIndex in PostgreSQL)
      if (
        Array.isArray(extractionResult.pages) &&
        extractionResult.pages.length > 0
      ) {
        const normalizedPages = extractionResult.pages.map((p, idx) => ({
          pageIndex:
            typeof p.pageIndex === 'number'
              ? p.pageIndex
              : typeof p.pageNumber === 'number'
                ? Math.max(0, p.pageNumber - 1)
                : idx,
          pageNumber:
            p.pageNumber ??
            (typeof p.pageIndex === 'number' ? p.pageIndex + 1 : idx + 1),
          textContent: p.text ?? p.textContent ?? '',
          charOffset: p.charOffset ?? 0,
        }));

        try {
          if (this.eventEmitter) {
            this.eventEmitter.emit('library.attachment.pages.extracted', {
              attachmentId: attachment.id,
              itemId: attachment.itemId,
              pages: normalizedPages.map((p) => ({
                pageNumber: p.pageNumber,
                pageIndex: p.pageIndex,
                textContent: p.textContent,
                charOffset: p.charOffset,
              })),
            });
          } else if (this.searchFacade?.indexAttachmentPages) {
            await this.searchFacade.indexAttachmentPages(
              attachment.id,
              normalizedPages,
            );
          } else if (this.extractionRepo.indexAttachmentPages) {
            await this.extractionRepo.indexAttachmentPages(
              attachment.id,
              normalizedPages,
            );
          }
        } catch (indexErr: unknown) {
          const msg =
            indexErr instanceof Error ? indexErr.message : String(indexErr);
          this.logger.warn(
            `Failed to index extracted pages for attachment ${attachment.id}: ${msg}`,
          );
        }
      }

      // 4.1. Store OCR provenance and quality stats if any pages were OCR'd
      if (doc.ocrProvenance && doc.ocrProvenance.totalOcrPages > 0) {
        try {
          await this.extractionRepo.saveMetadataSourceRecord(
            attachment.itemId,
            'ocr_provenance',
            doc.ocrProvenance as unknown as Prisma.InputJsonValue,
          );

          const existingMeta =
            attachment.metadata && typeof attachment.metadata === 'object'
              ? (attachment.metadata as Record<string, unknown>)
              : {};
          await this.extractionRepo.updateAttachmentMetadata(attachment.id, {
            ...existingMeta,
            ocr: {
              totalOcrPages: doc.ocrProvenance.totalOcrPages,
              avgConfidence: doc.ocrProvenance.avgConfidence,
              executionTimeMs: doc.ocrProvenance.executionTimeMs,
            },
          });
        } catch (ocrErr: unknown) {
          const message =
            ocrErr instanceof Error ? ocrErr.message : String(ocrErr);
          this.logger.warn(`Failed to save OCR provenance: ${message}`);
        }
      }

      // 4.2. Persist Searchable Sandwich PDF and create revision if OCR produced one
      if (
        doc.searchablePdfBuffer &&
        doc.ocrProvenance &&
        doc.ocrProvenance.totalOcrPages > 0 &&
        this.storagePort?.uploadFile
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
        } catch (sandwichErr: unknown) {
          const message =
            sandwichErr instanceof Error
              ? sandwichErr.message
              : String(sandwichErr);
          this.logger.warn(
            `Failed to persist searchable sandwich PDF for attachment ${attachment.id}: ${message}`,
          );
        }
      }

      // 5. Store authoritative PDF extraction provenance & full-text tree
      if (signal?.aborted) {
        throw new ExtractionProcessException(
          `Extraction aborted due to lost lease before metadata sync for attachment ${attachmentId}`,
          { eventId: event.id, attachmentId },
        );
      }
      await this.metadataSync.offloadFullTextAndSyncMetadata(
        attachment,
        doc,
        extractionResult,
        { skipOutboxPublish: true },
      );

      const effectiveUserId =
        attachment.item?.userId ||
        (typeof payload.userId === 'string' ? payload.userId : undefined) ||
        'system';
      const effectiveProjectId = normalizeProjectScopeId(
        attachment.item?.projectId ||
          (typeof payload.projectId === 'string'
            ? payload.projectId
            : undefined),
      );
      const scopeId = effectiveProjectId || effectiveUserId;

      // 6. Build in-library citation graph (match references against papers in same project scope)
      if (doc.references && doc.references.length > 0 && scopeId) {
        try {
          await this.linkInLibraryCitations(
            { userId: effectiveUserId, projectId: effectiveProjectId },
            attachment.itemId,
            doc.references,
          );
        } catch (linkErr: unknown) {
          const message =
            linkErr instanceof Error ? linkErr.message : String(linkErr);
          this.logger.warn(`In-library citation linking warning: ${message}`);
        }
      }

      // 7. Update status to READY on completion
      await this.extractionRepo.markReady(attachment.id);

      // 8. Invalidate all relevant Redis keys BEFORE publishing ITEM_UPDATED or emitting ATTACHMENT_METADATA_EXTRACTED
      // so downstream listeners (e.g. SearchEventsSubscriber, RetractionWatch, MetadataResolverService) read fresh item state & version
      if (this.cacheCoordinator) {
        try {
          await this.cacheCoordinator.invalidateForWrite({
            userId: effectiveUserId,
            projectId: effectiveProjectId,
            itemIds: [attachment.itemId],
          });
        } catch (cacheErr: unknown) {
          const msg =
            cacheErr instanceof Error ? cacheErr.message : String(cacheErr);
          this.logger.warn(
            `Failed to invalidate Redis caches via ItemCacheCoordinator after extraction for item ${attachment.itemId}: ${msg}`,
          );
        }
      } else if (this.cache) {
        try {
          const invalidationTasks: Promise<unknown>[] = [
            this.cache.del(LIBRARY_REDIS_KEYS.item(attachment.itemId)),
            this.cache.del(LIBRARY_REDIS_KEYS.itemDetails(attachment.itemId)),
            this.cache.del(LIBRARY_REDIS_KEYS.itemFulltext(attachment.itemId)),
            this.cache.del(`library:item:${attachment.itemId}:attachments`),
            this.cache.del(`library:item:${attachment.itemId}:notes`),
            this.cache.delPattern(
              LIBRARY_REDIS_KEYS.itemPattern(attachment.itemId),
            ),
            this.cache.delPattern(LIBRARY_REDIS_KEYS.itemsPattern(scopeId)),
            this.cache.del(LIBRARY_REDIS_KEYS.counts(scopeId)),
            this.cache.del(`library:counts:user:${effectiveUserId}`),
            this.cache.del(LIBRARY_REDIS_KEYS.tags(scopeId)),
            this.cache.delPattern(LIBRARY_REDIS_KEYS.tagsPattern(scopeId)),
            this.cache.delPattern(
              LIBRARY_REDIS_KEYS.searchItemsPattern(scopeId),
            ),
            this.cache.delPattern(
              LIBRARY_REDIS_KEYS.searchFacetsPattern(scopeId),
            ),
            this.cache.del(LIBRARY_REDIS_KEYS.savedSearches(scopeId)),
          ];
          if (effectiveProjectId) {
            invalidationTasks.push(
              this.cache.delPattern(
                LIBRARY_REDIS_KEYS.itemsPattern(`proj:${effectiveProjectId}`),
              ),
              this.cache.delPattern(
                LIBRARY_REDIS_KEYS.itemsPattern(effectiveUserId),
              ),
              this.cache.del(`library:counts:proj:${effectiveProjectId}`),
              this.cache.del(
                LIBRARY_REDIS_KEYS.tags(`proj:${effectiveProjectId}`),
              ),
              this.cache.delPattern(
                LIBRARY_REDIS_KEYS.tagsPattern(`proj:${effectiveProjectId}`),
              ),
              this.cache.delPattern(
                LIBRARY_REDIS_KEYS.tagsPattern(effectiveUserId),
              ),
              this.cache.delPattern(
                LIBRARY_REDIS_KEYS.searchItemsPattern(
                  `proj:${effectiveProjectId}`,
                ),
              ),
              this.cache.delPattern(
                LIBRARY_REDIS_KEYS.searchFacetsPattern(
                  `proj:${effectiveProjectId}`,
                ),
              ),
              this.cache.del(
                LIBRARY_REDIS_KEYS.savedSearches(effectiveUserId),
              ),
            );
          }
          await Promise.all(invalidationTasks);
        } catch (cacheErr: unknown) {
          const msg =
            cacheErr instanceof Error ? cacheErr.message : String(cacheErr);
          this.logger.warn(
            `Failed to invalidate Redis caches after extraction for item ${attachment.itemId}: ${msg}`,
          );
        }
      }

      // 9. Publish ITEM_UPDATED outbox event / domain event for SearchEventsSubscriber & Retraction checks
      const itemUpdatedPayload = {
        itemId: attachment.itemId,
        userId: effectiveUserId,
        projectId: effectiveProjectId,
        attachmentId: attachment.id,
      };
      const existingMetaObj =
        attachment.item?.metadata &&
        typeof attachment.item.metadata === 'object' &&
        !Array.isArray(attachment.item.metadata)
          ? (attachment.item.metadata as Record<string, unknown>)
          : {};
      const discoveredNewIdentifier = Boolean(
        (doc.metadata?.doi && !attachment.item?.doi) ||
          (doc.metadata?.arxivId &&
            !(attachment.item as Record<string, unknown> | null)?.arxivId &&
            !existingMetaObj.arxivId) ||
          (doc.metadata?.pmid && !existingMetaObj.pmid) ||
          (doc.metadata?.isbn && !existingMetaObj.isbn),
      );
      let outboxPublished = false;
      if (this.libraryTx?.executeInTransaction) {
        try {
          await this.libraryTx.executeInTransaction(async (_tx, helpers) => {
            await helpers.publishOutbox(
              { userId: effectiveUserId, projectId: effectiveProjectId },
              attachment.itemId,
              LIBRARY_EVENT_TYPES.ITEM_UPDATED,
              itemUpdatedPayload,
            );
          });
          outboxPublished = true;
        } catch (outboxErr: unknown) {
          const msg =
            outboxErr instanceof Error ? outboxErr.message : String(outboxErr);
          this.logger.debug(
            `Could not publish ITEM_UPDATED outbox after extraction: ${msg}`,
          );
        }
      }
      if (!outboxPublished) {
        this.eventEmitter?.emit(LIBRARY_EVENT_TYPES.ITEM_UPDATED, {
          eventId: event.id,
          userId: effectiveUserId,
          projectId: effectiveProjectId,
          scopeId,
          aggregateId: attachment.itemId,
          eventType: LIBRARY_EVENT_TYPES.ITEM_UPDATED,
          payload: itemUpdatedPayload,
          createdAt: new Date(),
          schemaVersion: 1,
        });
      }

      if (
        this.eventEmitter &&
        (discoveredNewIdentifier ||
          (doc.metadata?.title && !existingMetaObj.isVerified))
      ) {
        this.eventEmitter.emit(LIBRARY_EVENT_TYPES.ATTACHMENT_METADATA_EXTRACTED, {
          userId: effectiveUserId,
          projectId: effectiveProjectId,
          itemId: attachment.itemId,
          attachmentId: attachment.id,
          extractedMetadata: {
            title: doc.metadata?.title,
            doi: doc.metadata?.doi,
            arxivId: doc.metadata?.arxivId,
            pmid: doc.metadata?.pmid,
            isbn: doc.metadata?.isbn,
            issn: doc.metadata?.issn,
            abstract: doc.metadata?.abstract,
            year: doc.metadata?.year,
            publicationTitle:
              (doc.metadata as Record<string, unknown> | null)?.publicationTitle ||
              doc.metadata?.journal,
            authors: doc.metadata?.authors,
            creators: doc.metadata?.creators,
          },
          isOcrDerived: Boolean(
            doc.ocrProvenance && doc.ocrProvenance.totalOcrPages > 0,
          ),
        });
      }

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
    } catch (err: unknown) {
      const updatedAttachment = await this.extractionRepo.findUniqueAttachment(
        attachmentId,
        {
          select: { extractionAttempts: true },
        },
      );

      const currentAttempts = updatedAttachment?.extractionAttempts ?? 1;
      const isFinal = currentAttempts >= this.maxAttempts;
      const nextStatus = isFinal ? 'FAILED_FINAL' : 'FAILED_RETRYABLE';
      const message = err instanceof Error ? err.message : String(err);
      const sanitizedError = String(message || 'Extraction error').slice(
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
    scope: { userId?: string; projectId?: string | null } | string,
    sourceItemId: string,
    references: Array<{
      title?: string;
      doi?: string;
      arxivId?: string;
      authors?: string[];
      year?: number | string;
      rawText?: string;
    }>,
  ): Promise<void> {
    if (!this.extractionRepo?.findScopePapers) {
      return;
    }
    const matcher =
      this.referenceMatcher ?? new ReferenceMatcherService(this.extractionRepo);
    await matcher.linkCitationsInLibrary(scope, sourceItemId, references);
  }
}
