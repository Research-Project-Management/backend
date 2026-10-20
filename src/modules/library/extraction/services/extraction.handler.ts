import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import crypto from 'crypto';
import zlib from 'zlib';
import { promisify } from 'util';

const gzipAsync = promisify(zlib.gzip);
import { ExtractionRepository } from '@/modules/library/extraction/repositories/extraction.repository';
import { PdfProvider } from '@/modules/library/extraction/providers/pdf.provider';
import { STORAGE_PORT, IStoragePort } from '@/modules/storage/storage.port';
import { OutboxEvent, Prisma } from '@prisma/client';
import {
  OutboxDispatchHandler,
  LIBRARY_EVENT_TYPES,
  normalizeProjectScopeId,
  parseCreatorString,
  isNoiseAuthorName,
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
import { ReferenceMatcherService } from './reference-matcher.service';

export const EXTRACTION_EVENT_TYPES = {
  EXTRACTION_REQUESTED: 'library.attachment.extraction_requested',
  PAGES_EXTRACTED: 'library.attachment.pages.extracted',
} as const;

@Injectable()
export class ExtractionHandler implements OutboxDispatchHandler {
  private readonly logger = new Logger(ExtractionHandler.name);
  private readonly maxAttempts = 3;
  private readonly staleThresholdMs = 5 * 60 * 1000;

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
  ) {}

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
        this.logger.debug(
          `[AttachmentExtraction] Skipping duplicate or active extraction for event ${event.id} (${execResult.reason})`,
        );
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
      const storageFile = await this.storagePort.readOwnedFile({ fileId });
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
      const doc = await this.pdf.extractDocumentFromBuffer(buffer);
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
          } else if (
            typeof this.searchFacade?.indexAttachmentPages === 'function'
          ) {
            await this.searchFacade.indexAttachmentPages(
              attachment.id,
              normalizedPages,
            );
          } else if (
            typeof this.extractionRepo.indexAttachmentPages === 'function'
          ) {
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
      if (
        (doc.references && doc.references.length > 0) ||
        (doc.sections && doc.sections.length > 0) ||
        (doc.figures && doc.figures.length > 0) ||
        (doc.tables && doc.tables.length > 0) ||
        (doc.formulas && doc.formulas.length > 0) ||
        (doc.fullText && doc.fullText.trim().length > 0) ||
        (doc.pages && doc.pages.length > 0) ||
        (doc.metadata?.rawText && doc.metadata.rawText.trim().length > 0) ||
        (doc.metadata?.keywords && doc.metadata.keywords.length > 0) ||
        (doc.metadata?.notes && doc.metadata.notes.length > 0) ||
        Boolean(
          doc.metadata &&
          (doc.metadata.title ||
            doc.metadata.doi ||
            doc.metadata.abstract ||
            doc.metadata.year ||
            (doc.metadata.authors && doc.metadata.authors.length > 0) ||
            (doc.metadata.creators && doc.metadata.creators.length > 0)),
        )
      ) {
        try {
          const combinedPlainText =
            extractionResult.text ??
            doc.fullText ??
            (Array.isArray(doc.pages) && doc.pages.length > 0
              ? doc.pages.map((p) => p.textContent || '').join('\n')
              : doc.metadata?.rawText ?? '');
          const fulltextTree = {
            title: doc.metadata?.title,
            abstract: doc.metadata?.abstract,
            creators: doc.metadata?.creators,
            doi: doc.metadata?.doi,
            arxivId: doc.metadata?.arxivId,
            year: doc.metadata?.year,
            keywords: doc.metadata?.keywords,
            notes: doc.metadata?.notes,
            sections: extractionResult.sections ?? [],
            figures: extractionResult.figures ?? [],
            tables: extractionResult.tables ?? [],
            formulas: extractionResult.formulas ?? [],
            references: extractionResult.references ?? [],
            markdown: extractionResult.markdown ?? '',
            plainText: combinedPlainText,
            pageCount:
              extractionResult.pageCount ??
              doc.metadata?.numberOfPages ??
              (Array.isArray(doc.pages) ? doc.pages.length : 0),
          };

          let payloadToSave: Record<string, unknown> = {
            ...fulltextTree,
            referenceCount: fulltextTree.references.length,
          };

          // Claim Check Pattern: Offload heavy full-text tree to Object Storage
          if (typeof this.storagePort?.uploadFile === 'function') {
            try {
              const jsonBuffer = Buffer.from(
                JSON.stringify(fulltextTree),
                'utf-8',
              );
              const compressed = await gzipAsync(jsonBuffer);
              const ownerUserId = attachment.item?.userId || 'system';
              const ownerProjectId = attachment.item?.projectId || undefined;

              const uploadResult = await this.storagePort.uploadFile({
                userId: ownerUserId,
                projectId: ownerProjectId,
                filename: `pdf_fulltext_${attachment.itemId}.json.gz`,
                buffer: compressed,
                mimeType: 'application/gzip',
                source: 'reader.pdf_fulltext',
              });

              if (uploadResult?.fileId) {
                payloadToSave = {
                  isOffloaded: true,
                  fileId: uploadResult.fileId,
                  url: uploadResult.url,
                  storageKey: uploadResult.path,
                  byteSize: compressed.length,
                  uncompressedSize: jsonBuffer.length,
                  title: doc.metadata?.title,
                  abstract: doc.metadata?.abstract,
                  referenceCount: fulltextTree.references.length,
                  pageCount: fulltextTree.pageCount,
                };
              }
            } catch (offloadErr: unknown) {
              const message =
                offloadErr instanceof Error
                  ? offloadErr.message
                  : String(offloadErr);
              this.logger.warn(
                `Failed to offload PDF fulltext to storage, falling back to inline: ${message}`,
              );
            }
          }

          // Store full-text structured tree (Claim Check reference or inline)
          const savedFulltextRecord =
            await this.extractionRepo.saveMetadataSourceRecord(
              attachment.itemId,
              'pdf_fulltext',
              payloadToSave as unknown as Prisma.InputJsonValue,
            );

          if (
            savedFulltextRecord &&
            'supersededFileIds' in savedFulltextRecord &&
            Array.isArray(savedFulltextRecord.supersededFileIds) &&
            typeof this.storagePort?.deleteFile === 'function'
          ) {
            for (const oldFileId of savedFulltextRecord.supersededFileIds) {
              try {
                await this.storagePort.deleteFile(oldFileId);
              } catch (delErr: unknown) {
                const msg =
                  delErr instanceof Error ? delErr.message : String(delErr);
                this.logger.warn(
                  `Failed to delete superseded pdf_fulltext blob ${oldFileId}: ${msg}`,
                );
              }
            }
          }

          // Save native metadata extraction provenance record
          await this.extractionRepo.saveMetadataSourceRecord(
            attachment.itemId,
            'mextract',
            {
              title: doc.metadata.title,
              abstract: doc.metadata.abstract,
              creators: doc.metadata.creators,
              doi: doc.metadata.doi,
              arxivId: doc.metadata.arxivId,
              year: doc.metadata.year,
              keywords: doc.metadata.keywords,
              notes: doc.metadata.notes,
              referenceCount: doc.references?.length ?? 0,
              references: doc.references ?? [],
            } as unknown as Prisma.InputJsonValue,
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

          const existingMeta =
            typeof attachment.item?.metadata === 'object' &&
            attachment.item?.metadata !== null
              ? (attachment.item.metadata as Record<string, unknown>)
              : {};
          const metaPatch: Record<string, unknown> = {};
          if (doc.references && doc.references.length > 0) {
            metaPatch.referenceCount = doc.references.length;
          }
          if (doc.metadata?.arxivId && !existingMeta.arxivId) {
            metaPatch.arxivId = doc.metadata.arxivId;
          }

          const backfillKeys = [
            'isbn',
            'issn',
            'pmid',
            'volume',
            'issue',
            'pages',
            'publisher',
            'place',
            'conferenceName',
            'bookTitle',
            'publicationDate',
            'numberOfPages',
            'primaryCategory',
          ] as const;
          for (const key of backfillKeys) {
            const val = doc.metadata?.[key];
            if (
              val !== undefined &&
              val !== null &&
              val !== '' &&
              (existingMeta[key] === undefined ||
                existingMeta[key] === null ||
                existingMeta[key] === '')
            ) {
              metaPatch[key] = val;
            }
          }

          const fallbackPubTitle =
            doc.metadata?.journal ||
            doc.metadata?.bookTitle ||
            doc.metadata?.conferenceName;

          const existingItemRecord = (attachment.item ?? {}) as Record<
            string,
            unknown
          >;

          const itemPatch: Prisma.ItemUpdateInput = {
            ...(shouldUpdateTitle ? { title: doc.metadata.title } : {}),
            ...(!attachment.item?.doi && doc.metadata?.doi
              ? { doi: doc.metadata.doi }
              : {}),
            ...(!existingItemRecord.arxivId && doc.metadata?.arxivId
              ? { arxivId: doc.metadata.arxivId }
              : {}),
            ...(!existingItemRecord.pmid && doc.metadata?.pmid
              ? { pmid: doc.metadata.pmid }
              : {}),
            ...(!existingItemRecord.isbn && doc.metadata?.isbn
              ? { isbn: doc.metadata.isbn }
              : {}),
            ...(!existingItemRecord.issn && doc.metadata?.issn
              ? { issn: doc.metadata.issn }
              : {}),
            ...(!attachment.item?.abstract && doc.metadata?.abstract
              ? { abstract: doc.metadata.abstract }
              : {}),
            ...(!attachment.item?.year && doc.metadata?.year
              ? { year: doc.metadata.year }
              : {}),
            ...(!attachment.item?.publicationTitle && fallbackPubTitle
              ? {
                  publicationTitle: fallbackPubTitle,
                }
              : {}),
            ...(Object.keys(metaPatch).length > 0
              ? {
                  metadata: {
                    ...existingMeta,
                    ...metaPatch,
                  } as unknown as Prisma.InputJsonValue,
                }
              : {}),
          };

          if (Object.keys(itemPatch).length > 0) {
            await this.extractionRepo.updateItem(attachment.itemId, itemPatch);
          }

          const creatorType = 'author';
          const creatorsToSync =
            doc.metadata?.creators && doc.metadata.creators.length > 0
              ? doc.metadata.creators
              : doc.metadata?.authors && doc.metadata.authors.length > 0
                ? doc.metadata.authors.map((name) => ({ fullName: name }))
                : [];

          if (creatorsToSync.length > 0) {
            const count = await this.extractionRepo.countContributors(
              attachment.itemId,
            );
            if (count === 0) {
              const validContributors = creatorsToSync
                .map(
                  (
                    c: {
                      creatorType?: string;
                      fullName?: string;
                      name?: string;
                      firstName?: string;
                      lastName?: string;
                      fieldMode?: number;
                    },
                    idx,
                  ) => {
                    const itemCreatorType = c.creatorType || creatorType;
                    const rawName =
                      c.fullName ||
                      c.name ||
                      `${c.firstName || ''} ${c.lastName || ''}`.trim();
                    const parsed = parseCreatorString(
                      rawName,
                      idx,
                      itemCreatorType,
                    );
                    const first = parsed.firstName || c.firstName || '';
                    const last = parsed.lastName || c.lastName || '';
                    const full =
                      parsed.fullName ||
                      rawName ||
                      [first, last].filter(Boolean).join(' ') ||
                      '';
                    if (!full || isNoiseAuthorName(full)) {
                      return null;
                    }
                    return {
                      itemId: attachment.itemId,
                      orderIndex: idx,
                      creatorType: itemCreatorType,
                      firstName: first,
                      lastName: last,
                      fullName: full,
                    };
                  },
                )
                .filter((c): c is NonNullable<typeof c> => c !== null);

              if (validContributors.length > 0) {
                await this.extractionRepo.createContributors(
                  validContributors.map((c, idx) => ({
                    ...c,
                    orderIndex: idx,
                  })),
                );
              }
            }
          }

          // Synchronize extracted keywords as automatic item tags
          if (doc.metadata?.keywords && doc.metadata.keywords.length > 0) {
            const tagCount = await this.extractionRepo.countItemTags(
              attachment.itemId,
            );
            if (tagCount === 0) {
              const effectiveUserId = attachment.item?.userId || 'system';
              await this.extractionRepo.syncItemTags({
                userId: effectiveUserId,
                itemId: attachment.itemId,
                rawTags: doc.metadata.keywords,
                projectId: attachment.item?.projectId,
              });
            }
          }

          // Synchronize extracted notes/annotations as item literature notes
          if (doc.metadata?.notes && doc.metadata.notes.length > 0) {
            const noteCount = await this.extractionRepo.countItemNotes(
              attachment.itemId,
            );
            if (noteCount === 0) {
              const effectiveUserId = attachment.item?.userId || 'system';
              await this.extractionRepo.createItemNotes({
                userId: effectiveUserId,
                itemId: attachment.itemId,
                notes: doc.metadata.notes,
                projectId: attachment.item?.projectId,
              });
            }
          }
        } catch (provenanceErr: unknown) {
          const message =
            provenanceErr instanceof Error
              ? provenanceErr.message
              : String(provenanceErr);
          this.logger.debug(
            `Could not store extraction provenance: ${message}`,
          );
        }
      }

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
            scopeId,
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

      // 8. Publish ITEM_UPDATED outbox event / domain event for SearchEventsSubscriber & Retraction checks
      const itemUpdatedPayload = {
        itemId: attachment.itemId,
        userId: effectiveUserId,
        projectId: effectiveProjectId,
        attachmentId: attachment.id,
      };
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

      // 9. Invalidate all relevant Redis keys after extraction completes
      if (this.cache) {
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
    if (typeof this.extractionRepo?.findScopePapers !== 'function') {
      return;
    }
    const matcher =
      this.referenceMatcher ?? new ReferenceMatcherService(this.extractionRepo);
    await matcher.linkCitationsInLibrary(scope, sourceItemId, references);
  }
}
