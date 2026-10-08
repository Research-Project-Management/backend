import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import crypto from 'crypto';
import zlib from 'zlib';
import { ExtractionRepository } from '../repositories/extraction.repository';
import { PdfProvider } from './pdf.provider';
import { STORAGE_PORT, IStoragePort } from '@/modules/storage/storage.port';
import { OutboxEvent, Prisma } from '@prisma/client';
import {
  OutboxDispatchHandler,
  IdempotentConsumerService,
} from '../../shared-kernel';
import { AttachmentStorageException } from '../types/attachments.types';
import {
  parseCreatorString,
  isNoiseAuthorName,
} from '../../shared-kernel/utils/bibliographic.utils';

export const EXTRACTION_EVENT_TYPES = {
  EXTRACTION_REQUESTED: 'library.attachment.extraction_requested',
} as const;

export const ATTACHMENT_EXTRACTION_STALE_THRESHOLD =
  'ATTACHMENT_EXTRACTION_STALE_THRESHOLD';

export interface IAttachmentSearchIndexer {
  indexAttachmentPages?(attachmentId: string, pages: any[]): Promise<void>;
}

@Injectable()
export class ExtractionHandler implements OutboxDispatchHandler {
  private readonly logger = new Logger(ExtractionHandler.name);
  private readonly maxAttempts = 3;
  private readonly staleThresholdMs: number;
  private readonly storagePort: IStoragePort;
  private readonly searchIndexer?: IAttachmentSearchIndexer;
  private readonly idempotentConsumer?: IdempotentConsumerService;

  constructor(
    private readonly extractionRepo: ExtractionRepository,
    private readonly pdf: PdfProvider,
    @Inject(STORAGE_PORT) storagePort: IStoragePort,
    @Optional()
    searchIndexerOrThreshold?: IAttachmentSearchIndexer | number,
    @Optional()
    @Inject(ATTACHMENT_EXTRACTION_STALE_THRESHOLD)
    staleThresholdOrIdempotent?: number | IdempotentConsumerService,
    @Optional()
    idempotentConsumer?: IdempotentConsumerService,
  ) {
    this.storagePort = storagePort;

    if (typeof searchIndexerOrThreshold === 'number') {
      this.staleThresholdMs = searchIndexerOrThreshold;
      this.idempotentConsumer =
        typeof (staleThresholdOrIdempotent as any)?.executeIdempotent ===
        'function'
          ? (staleThresholdOrIdempotent as IdempotentConsumerService)
          : idempotentConsumer;
    } else {
      this.searchIndexer = searchIndexerOrThreshold;
      if (typeof staleThresholdOrIdempotent === 'number') {
        this.staleThresholdMs = staleThresholdOrIdempotent;
        this.idempotentConsumer = idempotentConsumer;
      } else if (
        staleThresholdOrIdempotent &&
        typeof (staleThresholdOrIdempotent as any).executeIdempotent ===
          'function'
      ) {
        this.staleThresholdMs = 5 * 60 * 1000;
        this.idempotentConsumer =
          staleThresholdOrIdempotent as IdempotentConsumerService;
      } else {
        this.staleThresholdMs = 5 * 60 * 1000;
        this.idempotentConsumer = idempotentConsumer;
      }
    }
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
    payload: Record<string, any>,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) {
      throw new Error(`Extraction aborted for outbox event ${event.id}`);
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
      const storageFile =
        typeof this.storagePort?.readOwnedFile === 'function'
          ? await this.storagePort.readOwnedFile({ fileId })
          : typeof (this.storagePort as any)?.readFile === 'function'
            ? await (this.storagePort as any).readFile(fileId)
            : null;
      const buffer =
        storageFile?.buffer ||
        (Buffer.isBuffer(storageFile) ? storageFile : null);

      if (!buffer) {
        throw new AttachmentStorageException(
          `Could not resolve binary buffer for attachment ${attachmentId}`,
        );
      }

      // 3. Extract text and per-page structures
      const doc = await this.pdf.extractDocumentFromBuffer(buffer);

      // 4. Atomically index pages idempotently if search indexer is available
      if (doc.pages.length > 0 && this.searchIndexer?.indexAttachmentPages) {
        await this.searchIndexer.indexAttachmentPages(attachment.id, doc.pages);
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

      // 5. Store authoritative PDF extraction provenance & full-text tree
      if (
        (doc.references && doc.references.length > 0) ||
        (doc.sections && doc.sections.length > 0) ||
        (doc.metadata?.keywords && doc.metadata.keywords.length > 0) ||
        (doc.metadata?.notes && doc.metadata.notes.length > 0)
      ) {
        try {
          const fulltextTree = {
            title: doc.metadata?.title,
            abstract: doc.metadata?.abstract,
            creators: doc.metadata?.creators,
            doi: doc.metadata?.doi,
            arxivId: doc.metadata?.arxivId,
            year: doc.metadata?.year,
            keywords: doc.metadata?.keywords,
            notes: doc.metadata?.notes,
            sections: doc.sections ?? [],
            figures: doc.figures ?? [],
            tables: doc.tables ?? [],
            formulas: doc.formulas ?? [],
            references: doc.references ?? [],
          };

          let payloadToSave: any = {
            ...fulltextTree,
            sectionCount: doc.sections?.length ?? 0,
            figureCount: doc.figures?.length ?? 0,
            tableCount: doc.tables?.length ?? 0,
            formulaCount: doc.formulas?.length ?? 0,
            referenceCount: doc.references?.length ?? 0,
          };

          // Claim Check Pattern: Offload heavy full-text tree to Object Storage
          if (typeof this.storagePort?.uploadFile === 'function') {
            try {
              const jsonBuffer = Buffer.from(
                JSON.stringify(fulltextTree),
                'utf-8',
              );
              const compressed = zlib.gzipSync(jsonBuffer);
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
                  sectionCount: doc.sections?.length ?? 0,
                  figureCount: doc.figures?.length ?? 0,
                  tableCount: doc.tables?.length ?? 0,
                  formulaCount: doc.formulas?.length ?? 0,
                  referenceCount: doc.references?.length ?? 0,
                };
              }
            } catch (offloadErr: any) {
              this.logger.warn(
                `Failed to offload PDF fulltext to storage, falling back to inline: ${offloadErr?.message || offloadErr}`,
              );
            }
          }

          // Store full-text structured tree (Claim Check reference or inline)
          await this.extractionRepo.saveMetadataSourceRecord(
            attachment.itemId,
            'pdf_fulltext',
            payloadToSave,
          );
          await this.extractionRepo.saveMetadataSourceRecord(
            attachment.itemId,
            'grobid_fulltext',
            payloadToSave,
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
              notes: doc.metadata.notes,
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

          const existingMeta =
            typeof attachment.item?.metadata === 'object' &&
            attachment.item?.metadata !== null
              ? (attachment.item.metadata as Record<string, any>)
              : {};
          const metaPatch: Record<string, any> = {};
          if (doc.references && doc.references.length > 0) {
            metaPatch.referenceCount = doc.references.length;
          }
          if (doc.metadata?.arxivId) {
            metaPatch.arxivId = doc.metadata.arxivId;
          }

          const itemPatch: Prisma.ItemUpdateInput = {
            ...(shouldUpdateTitle ? { title: doc.metadata.title } : {}),
            ...(!attachment.item?.doi && doc.metadata?.doi
              ? { doi: doc.metadata.doi }
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
            ...(Object.keys(metaPatch).length > 0
              ? {
                  metadata: {
                    ...existingMeta,
                    ...metaPatch,
                  } as Prisma.InputJsonValue,
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
                .map((c: any, idx) => {
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
                })
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
    if (typeof this.extractionRepo?.findScopePapers !== 'function') {
      return;
    }
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
