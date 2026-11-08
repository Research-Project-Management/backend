import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ExtractionRepository } from '@/modules/library/extraction/repositories/extraction.repository';
import { PdfProvider } from '@/modules/library/extraction/providers/pdf.provider';
import { STORAGE_PORT, IStoragePort } from '@/modules/storage/storage.port';
import { OutboxEvent } from '@prisma/client';
import {
  OutboxDispatchHandler,
  OutboxEventRecord,
  LIBRARY_EVENT_TYPES,
  CATALOG_FACADE,
  ICatalogFacade,
  ITEM_CACHE_INVALIDATOR,
  IItemCacheInvalidator,
  SEARCH_FACADE,
  ISearchFacade,
  IDEMPOTENT_CONSUMER,
  IIdempotentConsumer,
  UNIT_OF_WORK,
  IUnitOfWork,
  normalizeProjectScopeId,
  extractFileIdFromUrl,
  ExtractionProcessException,
  AttachmentStorageException,
  executeStandardLibraryCacheInvalidation,
} from '@/modules/library/core';
import { RedisCacheService } from '@/core';
import { ReferenceMatcherService } from './reference-matcher.service';
import { ExtractionMetadataSynchronizer } from './extraction-metadata.synchronizer';
import { isRejectedCitedIdentifier } from '@/modules/library/extraction/domain/extraction-metadata-merge.policy';
import type { ClaimedAttachmentRecord } from '@/modules/library/core/types/extraction.types';

export const EXTRACTION_EVENT_TYPES = {
  EXTRACTION_REQUESTED: 'library.attachment.extraction_requested',
  PAGES_EXTRACTED: 'library.attachment.pages.extracted',
} as const;

type ExtractedPdfDocument = Awaited<ReturnType<PdfProvider['extractDocumentFromBuffer']>>;
type ExtractionResultWithPages = Omit<ExtractedPdfDocument, 'pages'> & {
  markdown?: string;
  text?: string;
  pageCount?: number;
  pages?: Array<{ pageIndex?: number; pageNumber?: number; textContent?: string; text?: string; charOffset?: number }>;
};
interface PostExtractionPipelineContext {
  event: OutboxEvent | OutboxEventRecord;
  attachmentId: string;
  attachment: ClaimedAttachmentRecord;
  doc: ExtractedPdfDocument;
  extractionResult: ExtractionResultWithPages;
  effectiveUserId: string;
  effectiveProjectId?: string;
  scopeId: string;
  signal?: AbortSignal;
  syncRes?: {
    outboxPublished?: boolean;
    cacheInvalidated?: boolean;
    itemMutated?: boolean;
  };
}

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
    @Optional() @Inject(IDEMPOTENT_CONSUMER)
    private readonly idempotentConsumer?: IIdempotentConsumer,
    @Optional()
    private readonly cache?: RedisCacheService,
    @Optional()
    private readonly referenceMatcher?: ReferenceMatcherService,
    @Optional()
    private readonly eventEmitter?: EventEmitter2,
    @Optional()
    @Inject(UNIT_OF_WORK)
    private readonly libraryTx?: IUnitOfWork,
    @Optional()
    @Inject(SEARCH_FACADE)
    private readonly searchGateway?: ISearchFacade,
    @Optional()
    metadataSync?: ExtractionMetadataSynchronizer,
    @Optional()
    @Inject(ITEM_CACHE_INVALIDATOR)
    private readonly cacheCoordinator?: IItemCacheInvalidator,
    @Optional()
    @Inject(CATALOG_FACADE)
    private readonly catalogGateway?: ICatalogFacade,
  ) {
    this.metadataSync =
      metadataSync ??
      new ExtractionMetadataSynchronizer(
        this.extractionRepo,
        this.libraryTx,
        this.storagePort,
        this.cacheCoordinator,
        this.catalogGateway,
      );
  }

  async handle(event: OutboxEvent | OutboxEventRecord, signal?: AbortSignal): Promise<void> {
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

    const lockKey = `flux:lock:extraction:${attachmentId}`;
    let lockToken: string | null = null;
    if (this.cache?.isReady()) {
      lockToken = await this.cache.acquireLock(lockKey, 120000); // 2 min distributed lease
      if (!lockToken) {
        this.logger.debug(
          `[AttachmentExtraction] Attachment ${attachmentId} is already locked by another worker. Skipping redundant extraction.`,
        );
        return;
      }
    }

    try {
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
    } finally {
      if (lockToken && this.cache) {
        await this.cache.releaseLock(lockKey, lockToken);
      }
    }
  }

  private async processExtraction(
    event: OutboxEvent | OutboxEventRecord,
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

      // 2. Backfill fileId (if missing) & storage-first reading in parallel
      const itemRec = attachment.item as { spaceId?: string; createdById?: string; userId?: string; projectId?: string | null } | null | undefined;
      const resolvedItemUserId = itemRec?.userId ?? itemRec?.createdById;
      const resolvedItemProjectId = itemRec?.projectId ?? (itemRec?.spaceId && itemRec.spaceId !== itemRec.createdById ? itemRec.spaceId : undefined);
      const [, storageFile] = await Promise.all([
        !attachment.fileId
          ? this.extractionRepo
              .updateAttachmentFileId(attachment.id, fileId)
              .catch((err: unknown) => {
                this.logger.warn(
                  `Failed to backfill attachment fileId for ${attachment.id}: ${err instanceof Error ? err.message : String(err)}`,
                );
              })
          : Promise.resolve(),
        this.storagePort.readOwnedFile({
          fileId,
          userId: resolvedItemUserId,
          projectId: resolvedItemProjectId ?? undefined,
        }),
      ]);
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
          : Buffer.from(rawBuffer);

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
      const extractionResult = doc as ExtractionResultWithPages;
      const effectiveUserId =
        resolvedItemUserId ||
        (typeof payload.userId === 'string' ? payload.userId : undefined) ||
        'system';
      const effectiveProjectId = normalizeProjectScopeId(
        resolvedItemProjectId ||
          (typeof payload.projectId === 'string' ? payload.projectId : undefined),
      );
      const scopeId = effectiveProjectId || effectiveUserId;

      await this.runPostExtractionPipeline({
        event,
        attachmentId,
        attachment,
        doc,
        extractionResult,
        effectiveUserId,
        effectiveProjectId,
        scopeId,
        signal,
      });

      this.logger.log(
        JSON.stringify({
          event: 'library.extraction.completed',
          attachmentId,
          itemId: attachment.itemId,
          pageCount: doc?.pages?.length ?? 0,
          referenceCount: doc?.references?.length ?? 0,
          hasMetadata: Boolean(doc?.metadata?.doi || doc?.metadata?.title),
        }),
      );
    } catch (err: unknown) {
      const updatedAttachment = await this.extractionRepo.findUniqueAttachment(
        attachmentId,
        { select: { extractionAttempts: true } },
      );
      const currentAttempts = updatedAttachment?.extractionAttempts ?? 1;
      const isFinal = currentAttempts >= this.maxAttempts;
      const nextStatus = isFinal ? 'FAILED_FINAL' : 'FAILED_RETRYABLE';
      const message = err instanceof Error ? err.message : String(err);
      const sanitizedError = String(message || 'Extraction error').slice(0, 500);

      await this.extractionRepo.markFailed(attachment.id, nextStatus, sanitizedError, isFinal);
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
      throw err;
    }
  }

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
    if (!this.extractionRepo?.findScopePapers) return;
    const matcher =
      this.referenceMatcher ?? new ReferenceMatcherService(this.extractionRepo);
    const res = await matcher.linkCitationsInLibrary(scope, sourceItemId, references);
    if (res?.matches && res.matches.length > 0 && this.libraryTx?.executeInTransaction) {
      const eventScope =
        typeof scope === 'string'
          ? { userId: scope, projectId: null }
          : {
              userId: scope.userId || 'system',
              projectId: normalizeProjectScopeId(scope.projectId),
            };
      try {
        await this.libraryTx.executeInTransaction(async (_tx, helpers) => {
          const entries = res.matches.map((m) => ({
            entityType: 'Relation',
            entityId: `${sourceItemId}:${m.targetItemId}`,
            action: 'create' as const,
            version: 1,
            data: {
              itemId: sourceItemId,
              fromItemId: sourceItemId,
              toItemId: m.targetItemId,
              targetItemId: m.targetItemId,
              relationType: 'cites',
            },
          }));
          if (helpers.appendChangesBatch) {
            await helpers.appendChangesBatch(eventScope, entries);
          } else {
            await Promise.all(
              entries.map((entry) => helpers.appendChange(eventScope, entry)),
            );
          }
        });
      } catch {
        // Fallback already handled by repository changelog write
      }
    }
  }

  private async runPostExtractionPipeline(ctx: PostExtractionPipelineContext): Promise<void> {
    await this.indexExtractedPagesStep(ctx);
    await this.linkCitationsStep(ctx);
    await this.markReadyAndSyncMetadataStep(ctx);

    try {
      await this.invalidateExtractionCachesStep(ctx);
    } catch (cacheErr: unknown) {
      this.logger.warn(
        `Non-fatal post-markReady cache invalidation failure for ${ctx.attachmentId}: ${cacheErr instanceof Error ? cacheErr.message : String(cacheErr)}`,
      );
    }

    try {
      await this.publishPostExtractionEventsStep(ctx);
    } catch (eventErr: unknown) {
      this.logger.warn(
        `Non-fatal post-markReady event emission failure for ${ctx.attachmentId}: ${eventErr instanceof Error ? eventErr.message : String(eventErr)}`,
      );
    }
  }

  private async indexExtractedPagesStep(ctx: PostExtractionPipelineContext): Promise<void> {
    const { attachment, extractionResult } = ctx;
    if (!Array.isArray(extractionResult?.pages) || extractionResult.pages.length === 0) return;

    const normalizedPages = extractionResult.pages.map((p, idx) => ({
      pageIndex:
        typeof p.pageIndex === 'number'
          ? p.pageIndex
          : typeof p.pageNumber === 'number'
            ? Math.max(0, p.pageNumber - 1)
            : idx,
      pageNumber:
        p.pageNumber ?? (typeof p.pageIndex === 'number' ? p.pageIndex + 1 : idx + 1),
      textContent: p.text ?? p.textContent ?? '',
      charOffset: p.charOffset ?? 0,
    }));

    try {
      await this.dispatchExtractedPagesIndexing(attachment.id, attachment.itemId, normalizedPages);
    } catch (indexErr: unknown) {
      const msg = indexErr instanceof Error ? indexErr.message : String(indexErr);
      this.logger.error(`Failed to index extracted pages for attachment ${attachment.id}: ${msg}`);
      throw indexErr;
    }
  }

  private async dispatchExtractedPagesIndexing(
    attachmentId: string,
    itemId: string,
    normalizedPages: Array<{ pageIndex: number; pageNumber: number; textContent: string; charOffset: number }>,
  ): Promise<void> {
    if (this.searchGateway?.indexAttachmentPages) {
      await this.searchGateway.indexAttachmentPages(
        attachmentId,
        normalizedPages.map((p) => ({
          pageIndex: p.pageIndex,
          textContent: p.textContent,
          charOffset: p.charOffset,
          itemId,
        })),
      );
      return;
    }
    if (this.eventEmitter) {
      await this.emitEventDurable(EXTRACTION_EVENT_TYPES.PAGES_EXTRACTED, {
        attachmentId,
        itemId,
        pages: normalizedPages.map((p) => ({
          pageNumber: p.pageNumber,
          pageIndex: p.pageIndex,
          textContent: p.textContent,
          charOffset: p.charOffset,
        })),
      });
      return;
    }
    if (this.extractionRepo.indexAttachmentPages) {
      await this.extractionRepo.indexAttachmentPages(attachmentId, normalizedPages, undefined, itemId);
    }
  }

  private async linkCitationsStep(ctx: PostExtractionPipelineContext): Promise<void> {
    const { event, attachmentId, attachment, doc, effectiveUserId, effectiveProjectId, scopeId, signal } = ctx;
    if (signal?.aborted) {
      throw new ExtractionProcessException(
        `Extraction aborted due to lost lease before metadata sync for attachment ${attachmentId}`,
        { eventId: event.id, attachmentId },
      );
    }
    const hasValidScope = Boolean(
      effectiveProjectId || (effectiveUserId && effectiveUserId !== 'system'),
    );
    if (doc?.references && doc.references.length > 0 && scopeId && hasValidScope) {
      try {
        await this.linkInLibraryCitations(
          { userId: effectiveUserId, projectId: effectiveProjectId },
          attachment.itemId,
          doc.references,
        );
      } catch (linkErr: unknown) {
        const message = linkErr instanceof Error ? linkErr.message : String(linkErr);
        this.logger.warn(`In-library citation linking warning: ${message}`);
      }
    }
  }

  private async markReadyAndSyncMetadataStep(ctx: PostExtractionPipelineContext): Promise<void> {
    const { attachment, doc, extractionResult } = ctx;
    ctx.syncRes = await this.metadataSync.offloadFullTextAndSyncMetadata(
      attachment,
      doc ?? {},
      extractionResult ?? {},
      { skipOutboxPublish: false },
    );
    await this.extractionRepo.markReady(attachment.id);
  }

  private async invalidateExtractionCachesStep(ctx: PostExtractionPipelineContext): Promise<void> {
    if (ctx.syncRes?.cacheInvalidated) {
      return;
    }
    const { attachment, effectiveUserId, effectiveProjectId } = ctx;
    const cacheInvalidator =
      this.cacheCoordinator?.invalidateForWrite
        ? this.cacheCoordinator
        : this.catalogGateway?.invalidateForWrite
          ? this.catalogGateway
          : undefined;

    await executeStandardLibraryCacheInvalidation(
      cacheInvalidator,
      this.cache,
      {
        userId: effectiveUserId,
        projectId: effectiveProjectId,
        itemIds: [attachment.itemId],
      },
      (msg) =>
        this.logger.warn(
          `Failed to invalidate Redis caches after extraction for item ${attachment.itemId}: ${msg}`,
        ),
    );
  }

  private async publishPostExtractionEventsStep(ctx: PostExtractionPipelineContext): Promise<void> {
    const { event, attachment, doc, effectiveUserId, effectiveProjectId, scopeId, syncRes } = ctx;
    const itemUpdatedPayload = {
      itemId: attachment.itemId,
      userId: effectiveUserId,
      projectId: effectiveProjectId,
      attachmentId: attachment.id,
    };
    const existingMetaObj =
      attachment.item?.metadata &&
      typeof attachment.item?.metadata === 'object' &&
      !Array.isArray(attachment.item.metadata)
        ? (attachment.item.metadata as Record<string, unknown>)
        : {};
    const itemRecord = (attachment.item || {}) as Record<string, unknown>;
    const isSupplementary =
      String((attachment as Record<string, unknown>).attachmentType || '')
        .trim()
        .toLowerCase() === 'supplementary';
    const rejectedCitedId = existingMetaObj.rejectedCitedDoi;
    const safeDoi =
      doc?.metadata?.doi && !isRejectedCitedIdentifier(doc.metadata.doi, rejectedCitedId)
        ? doc.metadata.doi
        : undefined;
    const safeArxiv =
      doc?.metadata?.arxivId && !isRejectedCitedIdentifier(doc.metadata.arxivId, rejectedCitedId)
        ? doc.metadata.arxivId
        : undefined;
    const safePmid =
      doc?.metadata?.pmid && !isRejectedCitedIdentifier(doc.metadata.pmid, rejectedCitedId)
        ? doc.metadata.pmid
        : undefined;
    const safeIsbn =
      doc?.metadata?.isbn && !isRejectedCitedIdentifier(doc.metadata.isbn, rejectedCitedId)
        ? doc.metadata.isbn
        : undefined;

    const discoveredNewIdentifier =
      !isSupplementary &&
      Boolean(
        (safeDoi && !attachment.item?.doi && !existingMetaObj.doi) ||
          (safeArxiv && !itemRecord.arxivId && !existingMetaObj.arxivId) ||
          (safePmid && !itemRecord.pmid && !existingMetaObj.pmid) ||
          (safeIsbn && !itemRecord.isbn && !existingMetaObj.isbn),
      );

    if (syncRes?.itemMutated && !syncRes?.outboxPublished) {
      await this.emitEventDurable(LIBRARY_EVENT_TYPES.ITEM_UPDATED, {
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

    const hasExtractedIdentifier = !isSupplementary && Boolean(safeDoi || safeArxiv || safePmid || safeIsbn);
    const existingEngine = typeof existingMetaObj.engineUsed === 'string' ? existingMetaObj.engineUsed.trim() : '';
    const alreadyResolvedByRegistry = Boolean(
      existingMetaObj.isVerified ||
        existingMetaObj.resolvedAt ||
        (existingEngine.length > 0 && !['StagedPdf', 'LocalPDFExtraction', 'pdf_metadata'].includes(existingEngine)),
    );

    if (
      this.eventEmitter &&
      !isSupplementary &&
      (discoveredNewIdentifier ||
        (hasExtractedIdentifier &&
          Boolean(doc?.metadata?.title) &&
          !alreadyResolvedByRegistry))
    ) {
      await this.emitEventDurable(LIBRARY_EVENT_TYPES.ATTACHMENT_METADATA_EXTRACTED, {
        userId: effectiveUserId,
        projectId: effectiveProjectId,
        itemId: attachment.itemId,
        attachmentId: attachment.id,
        extractedMetadata: {
          title: doc?.metadata?.title,
          doi: safeDoi,
          arxivId: safeArxiv,
          pmid: safePmid,
          isbn: safeIsbn,
          issn: doc?.metadata?.issn,
          abstract: doc?.metadata?.abstract,
          year: doc?.metadata?.year,
          publicationTitle:
            (doc?.metadata as Record<string, unknown> | null)?.publicationTitle ||
            doc?.metadata?.journal,
          authors: doc?.metadata?.authors,
          creators: doc?.metadata?.creators,
        },
      });
    }
  }

  private async emitEventDurable(
    eventName: string,
    payload: unknown,
  ): Promise<void> {
    if (!this.eventEmitter) return;
    try {
      if (typeof this.eventEmitter.emitAsync === 'function') {
        await this.eventEmitter.emitAsync(eventName, payload);
      } else {
        this.eventEmitter.emit(eventName, payload);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Event listener error during ${eventName}: ${msg}`);
      if (
        this.searchGateway?.indexAttachmentPages &&
        typeof payload === 'object' &&
        payload &&
        'attachmentId' in payload &&
        'pages' in payload &&
        Array.isArray((payload as { pages?: unknown }).pages)
      ) {
        await this.searchGateway
          .indexAttachmentPages(
            (payload as { attachmentId: string }).attachmentId,
            (payload as { pages: Array<{ pageIndex: number; pageNumber: number; textContent: string; charOffset: number }> }).pages,
          )
          .catch(() => {});
      }
    }
  }
}
