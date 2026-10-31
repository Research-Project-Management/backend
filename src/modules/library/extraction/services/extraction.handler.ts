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
  executeStandardLibraryCacheInvalidation,
} from '@/modules/library/core';
import { AttachmentStorageException } from '@/modules/library/extraction/types/extraction.types';
import { RedisCacheService } from '@/core';
import { ReferenceMatcherService } from './reference-matcher.service';
import { ExtractionMetadataSynchronizer } from './extraction-metadata.synchronizer';

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
interface ClaimedAttachmentRecord {
  id: string;
  itemId: string;
  fileId?: string | null;
  url?: string;
  filename?: string;
  metadata?: unknown;
  item?: {
    id?: string;
    userId?: string;
    projectId?: string | null;
    title?: string;
    doi?: string | null;
    metadata?: unknown;
  } | null;
  [key: string]: unknown;
}
interface PostExtractionPipelineContext {
  event: OutboxEvent;
  attachmentId: string;
  attachment: ClaimedAttachmentRecord;
  doc: ExtractedPdfDocument;
  extractionResult: ExtractionResultWithPages;
  effectiveUserId: string;
  effectiveProjectId?: string;
  scopeId: string;
  signal?: AbortSignal;
  syncRes?: { outboxPublished?: boolean; cacheInvalidated?: boolean };
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
        attachment.item?.userId ||
        (typeof payload.userId === 'string' ? payload.userId : undefined) ||
        'system';
      const effectiveProjectId = normalizeProjectScopeId(
        attachment.item?.projectId ||
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
          pageCount: doc.pages.length,
          referenceCount: doc.references?.length ?? 0,
          hasMetadata: Boolean(doc.metadata.doi || doc.metadata.title),
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
          for (const m of res.matches) {
            await helpers.appendChange(eventScope, {
              entityType: 'Relation',
              entityId: `${sourceItemId}:${m.targetItemId}`,
              action: 'create',
              version: 1,
              data: {
                itemId: sourceItemId,
                fromItemId: sourceItemId,
                toItemId: m.targetItemId,
                targetItemId: m.targetItemId,
                relationType: 'cites',
              },
            });
          }
        });
      } catch {
        // Fallback already handled by repository changelog write
      }
    }
  }

  private async runPostExtractionPipeline(ctx: PostExtractionPipelineContext): Promise<void> {
    const steps: ReadonlyArray<(context: PostExtractionPipelineContext) => Promise<void>> = [
      (c) => this.persistOcrProvenanceStep(c),
      (c) => this.persistSearchableSandwichPdfStep(c),
      (c) => this.indexExtractedPagesStep(c),
      (c) => this.linkCitationsStep(c),
      (c) => this.markReadyAndSyncMetadataStep(c),
      (c) => this.invalidateExtractionCachesStep(c),
      (c) => this.publishPostExtractionEventsStep(c),
    ];
    for (const step of steps) {
      await step(ctx);
    }
  }

  private async persistOcrProvenanceStep(ctx: PostExtractionPipelineContext): Promise<void> {
    const { attachment, doc } = ctx;
    if (!doc.ocrProvenance || doc.ocrProvenance.totalOcrPages <= 0) return;
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
      const message = ocrErr instanceof Error ? ocrErr.message : String(ocrErr);
      this.logger.warn(`Failed to save OCR provenance: ${message}`);
    }
  }

  private async persistSearchableSandwichPdfStep(ctx: PostExtractionPipelineContext): Promise<void> {
    const { attachment, doc } = ctx;
    if (
      !doc.searchablePdfBuffer ||
      !doc.ocrProvenance ||
      doc.ocrProvenance.totalOcrPages <= 0 ||
      !this.storagePort?.uploadFile
    ) {
      return;
    }
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
        const hash = crypto.createHash('sha256').update(doc.searchablePdfBuffer).digest('hex');
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
      const message = sandwichErr instanceof Error ? sandwichErr.message : String(sandwichErr);
      this.logger.warn(`Failed to persist searchable sandwich PDF for attachment ${attachment.id}: ${message}`);
    }
  }

  private async indexExtractedPagesStep(ctx: PostExtractionPipelineContext): Promise<void> {
    const { attachment, extractionResult } = ctx;
    if (!Array.isArray(extractionResult.pages) || extractionResult.pages.length === 0) return;

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
      this.logger.warn(`Failed to index extracted pages for attachment ${attachment.id}: ${msg}`);
    }
  }

  private async dispatchExtractedPagesIndexing(
    attachmentId: string,
    itemId: string,
    normalizedPages: Array<{ pageIndex: number; pageNumber: number; textContent: string; charOffset: number }>,
  ): Promise<void> {
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
    if (this.searchGateway?.indexAttachmentPages) {
      await this.searchGateway.indexAttachmentPages(attachmentId, normalizedPages);
      return;
    }
    if (this.extractionRepo.indexAttachmentPages) {
      await this.extractionRepo.indexAttachmentPages(attachmentId, normalizedPages);
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
    if (doc.references && doc.references.length > 0 && scopeId) {
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
      doc,
      extractionResult,
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
    const discoveredNewIdentifier = Boolean(
      (doc.metadata?.doi && !attachment.item?.doi) ||
        (doc.metadata?.arxivId &&
          !(attachment.item as Record<string, unknown> | null)?.arxivId &&
          !existingMetaObj.arxivId) ||
        (doc.metadata?.pmid && !existingMetaObj.pmid) ||
        (doc.metadata?.isbn && !existingMetaObj.isbn),
    );

    if (!syncRes?.outboxPublished) {
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

    if (
      this.eventEmitter &&
      (discoveredNewIdentifier || (doc.metadata?.title && !existingMetaObj.isVerified))
    ) {
      await this.emitEventDurable(LIBRARY_EVENT_TYPES.ATTACHMENT_METADATA_EXTRACTED, {
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
        isOcrDerived: Boolean(doc.ocrProvenance && doc.ocrProvenance.totalOcrPages > 0),
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
    }
  }
}
