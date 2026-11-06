import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { ExtractionRepository } from '@/modules/library/extraction/repositories/extraction.repository';
import { normalizeDoi, normalizeArxivId } from '@/modules/library/core/domain/identifier.domain';
import { normalizeTitle } from '@/modules/library/core/domain/title.domain';
import { Prisma } from '@prisma/client';
import { AttachmentsService } from '@/modules/library/extraction/services/attachments.service';
import { PdfProvider } from '@/modules/library/extraction/providers/pdf.provider';
import { WebSnapshotService } from '@/modules/library/extraction/services/web-snapshot.service';
import { AnnotationsService } from '@/modules/library/extraction/services/annotations.service';
import { PdfMetadataExtractor } from '@/modules/library/extraction/providers/pdf-metadata.extractor';
import { ExtractedPdfDocument, ExtractedPdfMetadata, PdfMetadataExtractionResult, AttachmentEntity, CreateAttachmentInput, AnnotationEntity, CreateAnnotationData, UpdateAnnotationData, BatchAnnotationsData, BatchAnnotationsResult, AnnotationType } from '@/modules/library/core/types/extraction.types';
import { EXTRACTION_FACADE, IExtractionFacade, LIBRARY_EVENT_TYPES, DomainEventEnvelope, extractFileIdFromUrl } from '@/modules/library/core';
import { OnEvent } from '@nestjs/event-emitter';
import { STORAGE_PORT, IStoragePort } from '@/modules/storage/storage.port';
import { AnnotationsRepository } from '@/modules/library/extraction/repositories/annotations.repository';
import { AttachmentsRepository } from '@/modules/library/extraction/repositories/attachments.repository';

interface ExtractedReferenceCandidate {
  title?: string;
  doi?: string;
  arxivId?: string;
  authors?: string[];
  year?: number | string;
  rawText?: string;
}

interface ReferenceMatchResult {
  sourceItemId: string;
  targetItemId: string;
  matchType: 'DOI' | 'ARXIV' | 'TITLE_AUTHOR_YEAR' | 'TITLE';
  matchedTitle?: string;
  matchedDoi?: string;
}

interface ScopePaperRecord {
  id: string;
  title?: string | null;
  doi?: string | null;
  year?: number | null;
  metadata?: unknown;
  contributors?: Array<{
    lastName?: string | null;
    fullName?: string | null;
  }>;
}

@Injectable()
export class ReferenceMatcherService {
  private readonly logger = new Logger(ReferenceMatcherService.name);

  constructor(private readonly extractionRepo: ExtractionRepository) {}

  public static normalizeTitleKey(title: string): string {
    return normalizeTitle(title).replace(/\s+/g, '');
  }

  public static extractQuotedOrCleanedTitle(
    ref: ExtractedReferenceCandidate,
  ): string | undefined {
    if (ref.title && ref.title.trim().length > 5) {
      return ref.title.trim();
    }
    if (!ref.rawText) return undefined;

    // Match title in quotes: [1] A. Vaswani et al., "Attention is all you need," 2017.
    const quotedMatch = ref.rawText.match(
      /[""\u201C]([^""\u201D]{8,250})[""\u201D]/,
    );
    if (quotedMatch?.[1]) {
      return quotedMatch[1].replace(/[.,;]+$/, '').trim();
    }
    return undefined;
  }

  /**
   * Matches extracted bibliography references against items in the user's or project's library
   * using a single batch query (preventing N+1 database lookups) and O(1) hash maps.
   */
  async matchReferences(
    scope: { userId?: string; projectId?: string | null } | string,
    sourceItemId: string,
    references: ExtractedReferenceCandidate[],
  ): Promise<ReferenceMatchResult[]> {
    if (!references || references.length === 0) {
      return [];
    }

    const scopePapers = (await this.extractionRepo.findScopePapers(
      scope,
      sourceItemId,
    )) as ScopePaperRecord[];

    if (!scopePapers || scopePapers.length === 0) {
      return [];
    }

    const doiMap = new Map<string, ScopePaperRecord>();
    const arxivMap = new Map<string, ScopePaperRecord>();
    const titleMap = new Map<string, ScopePaperRecord>();

    for (const paper of scopePapers) {
      if (!paper.id || paper.id === sourceItemId) continue;

      const metaObj =
        paper.metadata &&
        typeof paper.metadata === 'object' &&
        !Array.isArray(paper.metadata)
          ? (paper.metadata as Record<string, unknown>)
          : {};

      const rawDoi =
        paper.doi ||
        (typeof metaObj.doi === 'string' ? metaObj.doi : undefined);
      const normDoi = normalizeDoi(rawDoi);
      if (normDoi) {
        doiMap.set(normDoi, paper);
      }

      const rawArxiv =
        typeof metaObj.arxivId === 'string' ? metaObj.arxivId : undefined;
      const normArxiv = normalizeArxivId(rawArxiv);
      if (normArxiv) {
        arxivMap.set(normArxiv, paper);
        const versionless = normalizeArxivId(rawArxiv, { stripVersion: true });
        if (versionless) {
          arxivMap.set(versionless, paper);
        }
      }

      if (paper.title && paper.title.trim().length > 8) {
        const normTitle = ReferenceMatcherService.normalizeTitleKey(
          paper.title,
        );
        if (normTitle.length > 6) {
          titleMap.set(normTitle, paper);
        }
      }
    }

    const resultsByTarget = new Map<string, ReferenceMatchResult>();

    for (const ref of references) {
      let matchedPaper: ScopePaperRecord | undefined;
      let matchType: ReferenceMatchResult['matchType'] = 'TITLE';

      // 1. Exact normalized DOI match (handles https://doi.org/..., doi:..., trailing periods)
      const candidateDoi = normalizeDoi(ref.doi || ref.rawText);
      if (candidateDoi && doiMap.has(candidateDoi)) {
        matchedPaper = doiMap.get(candidateDoi);
        matchType = 'DOI';
      }

      // 2. Exact normalized arXiv ID match
      if (!matchedPaper) {
        const rawArxivToken =
          ref.arxivId ||
          ref.rawText?.match(
            /(?:arxiv\s*[:./]\s*(?:abs\/|pdf\/)?|10\.48550\/arxiv\.)(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[a-z]{2})?\/\d{7}(?:v\d+)?)/i,
          )?.[1];
        const candidateArxiv = normalizeArxivId(rawArxivToken);
        const versionlessArxiv = normalizeArxivId(rawArxivToken, {
          stripVersion: true,
        });
        if (candidateArxiv && arxivMap.has(candidateArxiv)) {
          matchedPaper = arxivMap.get(candidateArxiv);
          matchType = 'ARXIV';
        } else if (versionlessArxiv && arxivMap.has(versionlessArxiv)) {
          matchedPaper = arxivMap.get(versionlessArxiv);
          matchType = 'ARXIV';
        }
      }

      // 3. Normalized Title (+ optional Author / Year confirmation)
      if (!matchedPaper) {
        const candidateTitle =
          ReferenceMatcherService.extractQuotedOrCleanedTitle(ref);
        if (candidateTitle && candidateTitle.length > 8) {
          const normTitle =
            ReferenceMatcherService.normalizeTitleKey(candidateTitle);
          const titleHit = titleMap.get(normTitle);
          if (titleHit) {
            const refYear = ref.year
              ? Number(ref.year)
              : ref.rawText?.match(/\b(19\d{2}|20\d{2})\b/)?.[1]
                ? Number(ref.rawText.match(/\b(19\d{2}|20\d{2})\b/)![1])
                : undefined;

            const yearConsistent =
              !refYear ||
              !titleHit.year ||
              Math.abs(titleHit.year - refYear) <= 1;

            if (yearConsistent) {
              matchedPaper = titleHit;
              matchType =
                refYear && titleHit.year ? 'TITLE_AUTHOR_YEAR' : 'TITLE';
            }
          }
        }
      }

      if (
        matchedPaper &&
        matchedPaper.id !== sourceItemId &&
        !resultsByTarget.has(matchedPaper.id)
      ) {
        resultsByTarget.set(matchedPaper.id, {
          sourceItemId,
          targetItemId: matchedPaper.id,
          matchType,
          matchedTitle:
            ref.title || matchedPaper.title || 'Cited in document bibliography',
          matchedDoi: candidateDoi || matchedPaper.doi || undefined,
        });
      }
    }

    return Array.from(resultsByTarget.values());
  }

  /**
   * Matches references and persists deduplicated 'cites' relations in the catalog graph.
   */
  async linkCitationsInLibrary(
    scope: { userId?: string; projectId?: string | null } | string,
    sourceItemId: string,
    references: ExtractedReferenceCandidate[],
  ): Promise<{ matchedCount: number; matches: ReferenceMatchResult[] }> {
    const matches = await this.matchReferences(scope, sourceItemId, references);
    if (matches.length === 0) {
      return { matchedCount: 0, matches: [] };
    }

    await Promise.all(
      matches.map(async (m) => {
        try {
          await this.extractionRepo.upsertItemCitationRelation(
            sourceItemId,
            m.targetItemId,
            m.matchedTitle || 'Cited in document bibliography',
          );
        } catch (err: unknown) {
          this.logger.debug(
            `Skipped duplicate or transient citation relation (${sourceItemId} -> ${m.targetItemId}): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }),
    );

    return { matchedCount: matches.length, matches };
  }
}

export { EXTRACTION_FACADE };
export type { IExtractionFacade };

@Injectable()
export class ExtractionFacade implements IExtractionFacade {
  constructor(
    private readonly attachmentsService: AttachmentsService,
    private readonly pdfProvider: PdfProvider,
    private readonly webSnapshotService: WebSnapshotService,
    private readonly annotationsService: AnnotationsService,
    private readonly trustedExtractor: PdfMetadataExtractor,
  ) {}

  async getItemAttachments(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<AttachmentEntity[]> {
    const res = await this.attachmentsService.getItemAttachments(
      userId,
      itemId,
      projectId,
    );
    return res.attachments || [];
  }

  async getItemAttachment(
    userId: string,
    attachmentId: string,
    itemId?: string,
    projectId?: string,
  ): Promise<AttachmentEntity | null> {
    const res = await this.attachmentsService.getItemAttachment(
      userId,
      itemId,
      attachmentId,
      projectId,
    );
    return res?.attachment || null;
  }

  async createAttachment(
    data: CreateAttachmentInput,
    projectId?: string,
  ): Promise<AttachmentEntity> {
    return await this.attachmentsService.createAttachment(data, projectId);
  }

  async extractDocumentFromBuffer(
    buffer: Buffer,
    options?: {
      maxPages?: number;
      headerOnly?: boolean;
      skipTrustedExtraction?: boolean;
    },
  ): Promise<ExtractedPdfDocument> {
    return this.pdfProvider.extractDocumentFromBuffer(buffer, options);
  }

  extractMetadataFromBuffer(buffer: Buffer): ExtractedPdfMetadata {
    return this.pdfProvider.extractMetadataFromBuffer(buffer);
  }

  async extractTrustedMetadata(
    buffer: Buffer,
    preferredFilename?: string,
  ): Promise<PdfMetadataExtractionResult> {
    return this.trustedExtractor.extract(buffer, preferredFilename);
  }

  async captureWebSnapshot(
    url: string,
    itemId: string,
    userId: string,
    projectId?: string,
  ): Promise<AttachmentEntity> {
    const res = await this.webSnapshotService.captureAndAttach(
      url,
      itemId,
      userId,
      projectId ? { projectId } : undefined,
    );
    return res.attachment;
  }

  async reassignContentToItem(
    duplicateItemIds: string[],
    primaryItemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<string[]> {
    return await this.attachmentsService.reassignToItem(
      duplicateItemIds,
      primaryItemId,
      tx,
    );
  }

  async cleanupOrphanedFiles(fileIds: string[]): Promise<void> {
    await this.attachmentsService.cleanupOrphanedFiles(fileIds);
  }

  // Annotation delegation methods

  async getAnnotationsByAttachment(
    userId: string,
    attachmentId: string,
    pageIndex?: number,
    type?: AnnotationType,
    projectId?: string,
  ): Promise<AnnotationEntity[]> {
    return this.annotationsService.getAnnotationsByAttachment(
      userId,
      attachmentId,
      pageIndex,
      type,
      projectId,
    );
  }

  async getAnnotation(
    userId: string,
    annotationId: string,
    projectId?: string,
  ): Promise<AnnotationEntity | null> {
    return this.annotationsService.getAnnotation(
      userId,
      annotationId,
      projectId,
    );
  }

  async createAnnotation(
    userId: string,
    data: CreateAnnotationData,
    projectId?: string,
  ): Promise<AnnotationEntity> {
    return this.annotationsService.createAnnotation(userId, data, projectId);
  }

  async updateAnnotation(
    userId: string,
    annotationId: string,
    expectedVersion: number,
    data: UpdateAnnotationData,
    projectId?: string,
  ): Promise<AnnotationEntity> {
    return this.annotationsService.updateAnnotation(
      userId,
      annotationId,
      expectedVersion,
      data,
      projectId,
    );
  }

  async deleteAnnotation(
    userId: string,
    annotationId: string,
    expectedVersion?: number,
    projectId?: string,
  ): Promise<boolean> {
    return this.annotationsService.deleteAnnotation(
      userId,
      annotationId,
      expectedVersion,
      projectId,
    );
  }

  async batchUpsertAnnotations(
    userId: string,
    attachmentId: string,
    data: BatchAnnotationsData,
    projectId?: string,
  ): Promise<BatchAnnotationsResult> {
    return this.annotationsService.batchUpsertAnnotations(
      userId,
      attachmentId,
      data,
      projectId,
    );
  }
}

/**
 * ItemLifecycleSubscriber in Extraction Bounded Context.
 * Listens to Catalog item deletion events to clean up or soft-delete content attachments and annotations.
 */
@Injectable()
export class ItemLifecycleSubscriber {
  private readonly logger = new Logger(ItemLifecycleSubscriber.name);

  constructor(
    private readonly attachmentsRepository: AttachmentsRepository,
    @Optional()
    private readonly annotationsRepository?: AnnotationsRepository,
    @Optional()
    @Inject(STORAGE_PORT)
    private readonly storagePort?: IStoragePort,
  ) {}

  @OnEvent(LIBRARY_EVENT_TYPES.ITEM_PURGED, { async: true })
  async handleItemPurged(event: unknown): Promise<void> {
    const payload = event as
      | {
          id?: string;
          aggregateId?: string;
          filePaths?: string[];
          cascadedInTx?: boolean;
          storageDeletedInTx?: boolean;
          payload?: {
            id?: string;
            itemId?: string;
            itemIds?: string[];
            filePaths?: string[];
            cascadedInTx?: boolean;
            storageDeletedInTx?: boolean;
          };
        }
      | null
      | undefined;
    if (
      (payload?.cascadedInTx || payload?.payload?.cascadedInTx) &&
      (payload?.storageDeletedInTx || payload?.payload?.storageDeletedInTx)
    ) {
      return;
    }
    const itemId =
      payload?.id ||
      payload?.aggregateId ||
      payload?.payload?.id ||
      payload?.payload?.itemId;
    if (!itemId) return;

    const rawFilePaths =
      payload?.payload?.filePaths ?? payload?.filePaths ?? [];
    const payloadFilePaths = Array.isArray(rawFilePaths)
      ? rawFilePaths.filter(
          (fp): fp is string => typeof fp === 'string' && fp.trim().length > 0,
        )
      : [];

    this.logger.log(
      `[ExtractionSubscriber] Purging attachments and annotations for purged item ${itemId}`,
    );

    try {
      const candidateFileIdsToDelete = new Set<string>(payloadFilePaths);
      if (this.storagePort?.deleteFile && this.attachmentsRepository?.findMany) {
        const attachments = await this.attachmentsRepository.findMany(
          { itemId },
          { revisions: true },
        );
        for (const att of attachments || []) {
          const attFileId = att.fileId || extractFileIdFromUrl(att.url);
          if (attFileId) candidateFileIdsToDelete.add(attFileId);
          const revisions = (
            att as {
              revisions?: Array<{
                fileId?: string | null;
                url?: string | null;
              }>;
            }
          ).revisions;
          if (Array.isArray(revisions)) {
            for (const rev of revisions) {
              const revFileId =
                rev.fileId || extractFileIdFromUrl(rev.url ?? undefined);
              if (revFileId) candidateFileIdsToDelete.add(revFileId);
            }
          }
        }
      }

      if (this.annotationsRepository) {
        await this.annotationsRepository.deleteManyByItemId(itemId);
      }
      if (this.attachmentsRepository?.deleteManyByItemId) {
        await this.attachmentsRepository.deleteManyByItemId(itemId);
      }

      if (this.storagePort?.deleteFile && candidateFileIdsToDelete.size > 0) {
        const candidateFileIds = Array.from(candidateFileIdsToDelete);
        await Promise.all(
          candidateFileIds.map(async (fid) => {
            try {
              if (
                typeof this.attachmentsRepository?.countFileIdReferences ===
                'function'
              ) {
                const remainingRefs =
                  await this.attachmentsRepository.countFileIdReferences(
                    fid,
                    undefined,
                    undefined,
                    itemId,
                  );
                if (typeof remainingRefs === 'number' && remainingRefs > 0) {
                  return;
                }
              }
              await this.storagePort!.deleteFile(fid);
            } catch (delErr: unknown) {
              const msg =
                delErr instanceof Error ? delErr.message : String(delErr);
              this.logger.warn(
                `[ExtractionSubscriber] Failed to delete storage file ${fid} for purged item ${itemId}: ${msg}`,
              );
            }
          }),
        );
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `[ExtractionSubscriber] Cascade purge error for item ${itemId}: ${errorMessage}`,
      );
    }
  }

  @OnEvent(LIBRARY_EVENT_TYPES.ITEM_DELETED, { async: true })
  async handleItemDeleted(
    event:
      | DomainEventEnvelope
      | { aggregateId?: string; cascadedInTx?: boolean; payload?: { itemId?: string; cascadedInTx?: boolean } },
  ): Promise<void> {
    const rawPayload = (event as { payload?: { itemId?: string; cascadedInTx?: boolean } } | undefined)?.payload;
    if ((event as { cascadedInTx?: boolean } | undefined)?.cascadedInTx || rawPayload?.cascadedInTx) {
      return;
    }
    const itemId =
      event?.aggregateId ||
      rawPayload?.itemId;
    if (!itemId) return;

    this.logger.log(
      `[ExtractionSubscriber] Cascading soft-delete to attachments and annotations for deleted item ${itemId}`,
    );

    try {
      const attachments = await this.attachmentsRepository.findMany({
        itemId,
        deletedAt: null,
      });
      const attachmentIds = (attachments || []).map(
        (attachment: { id: string }) => attachment.id,
      );

      if (attachmentIds.length > 0 && this.annotationsRepository) {
        await this.annotationsRepository.softDeleteByAttachmentIds(
          attachmentIds,
        );
      }
      await this.attachmentsRepository.softDeleteByItemId(itemId);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `[ExtractionSubscriber] Cascade cleanup error for item ${itemId}: ${errorMessage}`,
      );
    }
  }

  @OnEvent(LIBRARY_EVENT_TYPES.ITEM_RESTORED, { async: true })
  async handleItemRestored(
    event:
      | DomainEventEnvelope
      | { aggregateId?: string; cascadedInTx?: boolean; payload?: { itemId?: string; id?: string; cascadedInTx?: boolean } },
  ): Promise<void> {
    const rawPayload = event && 'payload' in event ? event.payload : undefined;
    if (
      (event as { cascadedInTx?: boolean } | undefined)?.cascadedInTx ||
      (rawPayload as { cascadedInTx?: boolean } | undefined)?.cascadedInTx
    ) {
      return;
    }
    const itemId =
      event?.aggregateId ||
      (rawPayload as { itemId?: string; id?: string } | undefined)?.itemId ||
      (rawPayload as { itemId?: string; id?: string } | undefined)?.id;
    if (!itemId) return;

    const deletedAtRaw = (
      rawPayload as { deletedAt?: string | Date } | undefined
    )?.deletedAt;
    const itemDeletedAt = deletedAtRaw ? new Date(deletedAtRaw) : undefined;

    this.logger.log(
      `[ExtractionSubscriber] Verifying attachment counts for restored item ${itemId}`,
    );

    try {
      // Note: CommandRepository.restore already cascades restore inside the DB transaction.
      // Only restore attachments/annotations if itemDeletedAt is explicitly provided so we never
      // blindly resurrect attachments that were deleted long before the item was deleted.
      if (
        itemDeletedAt &&
        !isNaN(itemDeletedAt.getTime()) &&
        this.attachmentsRepository?.findMany
      ) {
        const trashedAttachments = await this.attachmentsRepository.findMany({
          itemId,
          deletedAt: { gte: itemDeletedAt },
        });
        const attachmentIds = (trashedAttachments || []).map(
          (attachment: { id: string }) => attachment.id,
        );

        if (attachmentIds.length > 0 && this.annotationsRepository) {
          await this.annotationsRepository.restoreByAttachmentIds?.(
            attachmentIds,
          );
        }
      }
      await this.attachmentsRepository?.syncItemAttachmentCounts?.(itemId);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `[ExtractionSubscriber] Cascade restore error for item ${itemId}: ${errorMessage}`,
      );
    }
  }
}
