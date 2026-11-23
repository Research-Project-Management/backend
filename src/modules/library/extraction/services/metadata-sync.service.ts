import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ExtractionRepository } from '@/modules/library/extraction/repositories/extraction.repository';
import { IFilesPort, FILES_PORT } from '@/modules/files';
import {
  parseCreatorString,
  isNoiseAuthorName,
  LIBRARY_EVENT_TYPES,
  CATALOG_FACADE,
  ICatalogFacade,
  ITEM_CACHE_INVALIDATOR,
  IItemCacheInvalidator,
  normalizeProjectSpaceId,
  gzipAsync,
  UNIT_OF_WORK,
  IUnitOfWork,
  ItemsMapper,
  executeWithPostCommit,
} from '@/modules/library/core';
import {
  buildExtractedMetadataSyncPlan,
  ExtractionSyncAttachmentInput,
  ExtractionSyncDocumentInput,
} from '@/modules/library/extraction/domain/metadata-merge.policy';
import type {
  ClaimedAttachmentRecord,
  FullTextOffloadDocument,
  FullTextOffloadResult,
} from '@/modules/library/core/types/extraction.types';

@Injectable()
export class ExtractionMetadataSynchronizer {
  private readonly logger = new Logger(ExtractionMetadataSynchronizer.name);

  constructor(
    private readonly extractionRepo: ExtractionRepository,
    @Optional()
    @Inject(UNIT_OF_WORK)
    private readonly libraryTx?: IUnitOfWork,
    @Optional()
    @Inject(FILES_PORT)
    private readonly filesPort?: IFilesPort,
    @Optional()
    @Inject(ITEM_CACHE_INVALIDATOR)
    private readonly cacheCoordinator?: IItemCacheInvalidator,
    @Optional()
    @Inject(CATALOG_FACADE)
    private readonly catalogFacade?: ICatalogFacade,
  ) {}

  /**
   * Offloads structured full-text tree to Object Storage (Claim Check pattern)
   * and synchronizes extracted metadata (DOI, arXiv, title, year, contributors, keywords, notes) onto Item model.
   */
  async offloadFullTextAndSyncMetadata(
    attachment: ClaimedAttachmentRecord,
    doc: FullTextOffloadDocument,
    extractionResult: FullTextOffloadResult,
    options?: { skipOutboxPublish?: boolean; skipCacheInvalidation?: boolean },
  ): Promise<{
    outboxPublished: boolean;
    cacheInvalidated: boolean;
    itemMutated: boolean;
  }> {
    let outboxPublished = false;
    let cacheInvalidated = false;
    let itemMutated = false;
    if (
      (doc?.references && doc.references.length > 0) ||
      (doc?.sections && doc.sections.length > 0) ||
      (doc?.figures && doc.figures.length > 0) ||
      (doc?.tables && doc.tables.length > 0) ||
      (doc?.formulas && doc.formulas.length > 0) ||
      (doc?.fullText && doc.fullText.trim().length > 0) ||
      (doc?.pages && doc.pages.length > 0) ||
      (doc?.metadata?.rawText && doc.metadata.rawText.trim().length > 0) ||
      (doc?.metadata?.keywords && doc.metadata.keywords.length > 0) ||
      (doc?.metadata?.notes && doc.metadata.notes.length > 0) ||
      Boolean(
        doc?.metadata &&
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
          extractionResult?.text ??
          doc?.fullText ??
          (Array.isArray(doc?.pages) && doc.pages.length > 0
            ? doc.pages.map((p) => p.text ?? p.textContent ?? '').join('\n')
            : (doc?.metadata?.rawText ?? ''));

        const normalizedPages = Array.isArray(doc?.pages)
          ? doc.pages.map((p, idx) => ({
              pageNumber:
                p.pageNumber ??
                (typeof p.pageIndex === 'number' ? p.pageIndex + 1 : idx + 1),
              text: p.text ?? p.textContent ?? '',
            }))
          : [];
        const resolvedSections =
          extractionResult?.sections && extractionResult.sections.length > 0
            ? extractionResult.sections
            : (doc?.sections ?? []);

        const fulltextTree = {
          title: doc?.metadata?.title,
          abstract: doc?.metadata?.abstract,
          creators: doc?.metadata?.creators,
          doi: doc?.metadata?.doi,
          arxivId: doc?.metadata?.arxivId,
          year: doc?.metadata?.year,
          keywords: doc?.metadata?.keywords,
          notes: doc?.metadata?.notes,
          sections: resolvedSections,
          figures: extractionResult?.figures ?? doc?.figures ?? [],
          tables: extractionResult?.tables ?? doc?.tables ?? [],
          formulas: extractionResult?.formulas ?? doc?.formulas ?? [],
          references: extractionResult?.references ?? doc?.references ?? [],
          pages: normalizedPages,
          markdown: extractionResult?.markdown ?? '',
          plainText: combinedPlainText,
          pageCount:
            extractionResult?.pageCount ??
            doc?.metadata?.numberOfPages ??
            normalizedPages.length,
        };

        let payloadToSave: Record<string, unknown> = {
          ...fulltextTree,
          attachmentId: attachment.id,
          referenceCount: fulltextTree.references.length,
        };

        // Claim Check Pattern: Offload heavy full-text tree to Object Storage
        let uploadedFileId: string | undefined;
        let uploadedByteSize: number | undefined;
        const resolvedOwnerSpaceId =
          attachment.item?.spaceId ??
          attachment.item?.projectId ??
          attachment.item?.createdById ??
          attachment.item?.userId ??
          undefined;
        const resolvedOwnerUserId =
          attachment.item?.createdById ??
          attachment.item?.userId ??
          resolvedOwnerSpaceId ??
          'system';
        if (this.filesPort?.uploadFile) {
          try {
            const jsonBuffer = Buffer.from(
              JSON.stringify(fulltextTree),
              'utf-8',
            );
            const compressed = await gzipAsync(jsonBuffer);

            const uploadResult = await this.filesPort.uploadFile({
              userId: resolvedOwnerUserId,
              spaceId: resolvedOwnerSpaceId,
              filename: `pdf_fulltext_${attachment.itemId}_${attachment.id}.json.gz`,
              buffer: compressed,
              mimeType: 'application/gzip',
            });

            if (uploadResult?.fileId) {
              uploadedFileId = uploadResult.fileId;
              uploadedByteSize = compressed.length;
              payloadToSave = {
                isOffloaded: true,
                attachmentId: attachment.id,
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

        if (!payloadToSave.isOffloaded) {
          const INLINE_TEXT_CAP = 100_000;
          if (
            typeof payloadToSave.plainText === 'string' &&
            payloadToSave.plainText.length > INLINE_TEXT_CAP
          ) {
            payloadToSave.plainText = payloadToSave.plainText.slice(
              0,
              INLINE_TEXT_CAP,
            );
          }
          if (
            typeof payloadToSave.markdown === 'string' &&
            payloadToSave.markdown.length > INLINE_TEXT_CAP
          ) {
            payloadToSave.markdown = payloadToSave.markdown.slice(
              0,
              INLINE_TEXT_CAP,
            );
          }
        }

        // Store full-text structured tree, attachment structure, and native metadata provenance concurrently
        const [savedFulltextRecord] = await Promise.all([
          this.extractionRepo.saveMetadataSourceRecord(
            attachment.itemId,
            'pdf_fulltext',
            payloadToSave as unknown as Prisma.InputJsonValue,
          ),
          this.extractionRepo.upsertAttachmentStructure
            ? this.extractionRepo.upsertAttachmentStructure({
                attachmentId: attachment.id,
                itemId: attachment.itemId,
                pageCount:
                  typeof fulltextTree.pageCount === 'number'
                    ? fulltextTree.pageCount
                    : 0,
                qualityScore: extractionResult?.qualityScore,
                engineUsed: extractionResult?.engineUsed,
                sections: fulltextTree.sections as Prisma.InputJsonValue,
                figures: fulltextTree.figures as Prisma.InputJsonValue,
                tables: fulltextTree.tables as Prisma.InputJsonValue,
                formulas: fulltextTree.formulas as Prisma.InputJsonValue,
                references: fulltextTree.references as Prisma.InputJsonValue,
                fulltextFileId: uploadedFileId ?? null,
                fulltextByteSize: uploadedByteSize ?? null,
              })
            : Promise.resolve(),
          this.extractionRepo.saveMetadataSourceRecord(
            attachment.itemId,
            'pdf_metadata',
            {
              attachmentId: attachment.id,
              title: doc.metadata?.title,
              abstract: doc.metadata?.abstract,
              creators: doc.metadata?.creators,
              doi: doc.metadata?.doi,
              arxivId: doc.metadata?.arxivId,
              year: doc.metadata?.year,
              keywords: doc.metadata?.keywords,
              notes: doc.metadata?.notes,
              referenceCount: doc.references?.length ?? 0,
              references: doc.references ?? [],
            } as unknown as Prisma.InputJsonValue,
          ),
        ]);

        if (
          savedFulltextRecord &&
          'supersededFileIds' in savedFulltextRecord &&
          Array.isArray(savedFulltextRecord.supersededFileIds) &&
          this.filesPort?.deleteFile
        ) {
          const deleteFileFn = this.filesPort.deleteFile.bind(this.filesPort);
          const deleteTarget = resolvedOwnerSpaceId
            ? { spaceId: resolvedOwnerSpaceId }
            : undefined;
          await Promise.all(
            savedFulltextRecord.supersededFileIds.map(
              async (oldFileId: string) => {
                try {
                  await deleteFileFn(oldFileId, deleteTarget);
                } catch (delErr: unknown) {
                  const msg =
                    delErr instanceof Error ? delErr.message : String(delErr);
                  this.logger.warn(
                    `Failed to delete superseded pdf_fulltext blob ${oldFileId}: ${msg}`,
                  );
                }
              },
            ),
          );
        }

        const {
          itemPatch,
          extractedIdentifiers,
          creatorsToSync,
          primaryRole,
          tagsToSync,
          notesToSync,
        } = this.buildMetadataSyncPlan(attachment, doc);

        const runSideEffects = async (
          tx?: Prisma.TransactionClient,
          skipVersionIncrement = false,
        ) => {
          if (extractedIdentifiers.length > 0) {
            await this.extractionRepo.syncExtractedIdentifiers?.(
              attachment.itemId,
              extractedIdentifiers,
              tx,
            );
          }

          const [
            existingContributorsCount,
            existingTagsCount,
            existingNotesCount,
          ] = await Promise.all([
            creatorsToSync.length > 0
              ? this.extractionRepo.countContributors(attachment.itemId, tx)
              : Promise.resolve(0),
            tagsToSync.length > 0
              ? this.extractionRepo.countItemTags(attachment.itemId, tx)
              : Promise.resolve(0),
            notesToSync.length > 0
              ? this.extractionRepo.countItemNotes(attachment.itemId, tx)
              : Promise.resolve(0),
          ]);

          if (creatorsToSync.length > 0 && existingContributorsCount === 0) {
            const validContributors = creatorsToSync
              .map((c, idx) => {
                const candidate = c as {
                  creatorType?: string;
                  fullName?: string;
                  name?: string;
                  firstName?: string;
                  lastName?: string;
                  fieldMode?: number;
                };
                const itemCreatorType = candidate.creatorType || primaryRole;
                const rawName =
                  candidate.fullName ||
                  candidate.name ||
                  `${candidate.firstName || ''} ${candidate.lastName || ''}`.trim();
                const parsed = parseCreatorString(
                  rawName,
                  idx,
                  itemCreatorType,
                );
                const first = (
                  candidate.firstName ||
                  parsed.firstName ||
                  ''
                ).trim();
                const last = (
                  candidate.lastName ||
                  parsed.lastName ||
                  ''
                ).trim();
                const full =
                  (candidate.firstName || candidate.lastName
                    ? candidate.fullName ||
                      candidate.name ||
                      [first, last].filter(Boolean).join(' ')
                    : parsed.fullName) ||
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
                  fieldMode: candidate.fieldMode ?? parsed.fieldMode ?? 0,
                  firstName: first,
                  lastName: last,
                  fullName:
                    full ||
                    [first, last].filter(Boolean).join(' ') ||
                    'Unknown Author',
                };
              })
              .filter(Boolean);

            if (validContributors.length > 0) {
              await this.extractionRepo.createContributors(
                validContributors as unknown as Prisma.ContributorCreateManyInput[],
                tx,
                skipVersionIncrement
                  ? { skipVersionIncrement: true }
                  : undefined,
              );
            }
          }

          if (tagsToSync.length > 0 && existingTagsCount < 15) {
            const effectiveUserId = attachment.item?.userId || 'system';
            await this.extractionRepo.syncItemTags(
              {
                userId: effectiveUserId,
                itemId: attachment.itemId,
                rawTags: tagsToSync.slice(
                  0,
                  Math.max(1, 25 - existingTagsCount),
                ),
                projectId: attachment.item?.projectId,
                ...(skipVersionIncrement ? { skipVersionIncrement: true } : {}),
              },
              tx,
            );
          }

          if (notesToSync.length > 0 && existingNotesCount === 0) {
            const effectiveUserId = attachment.item?.userId || 'system';
            await this.extractionRepo.createItemNotes(
              {
                userId: effectiveUserId,
                itemId: attachment.itemId,
                notes: notesToSync,
                projectId: attachment.item?.projectId,
                ...(skipVersionIncrement ? { skipVersionIncrement: true } : {}),
              },
              tx,
            );
          }
        };

        const hasItemPatch = Object.keys(itemPatch).length > 0;
        const hasAnyMutation =
          hasItemPatch ||
          creatorsToSync.length > 0 ||
          extractedIdentifiers.length > 0 ||
          tagsToSync.length > 0 ||
          notesToSync.length > 0;

        const ownerProjectId = normalizeProjectSpaceId(
          attachment.item?.projectId ??
            (resolvedOwnerSpaceId &&
            resolvedOwnerSpaceId !== resolvedOwnerUserId
              ? resolvedOwnerSpaceId
              : undefined),
        );
        const eventScope = {
          userId: resolvedOwnerUserId,
          projectId: ownerProjectId,
        };

        const invalidateSyncedItemCache = async () => {
          if (options?.skipCacheInvalidation) return;
          const invalidator = this.cacheCoordinator?.invalidateForWrite
            ? this.cacheCoordinator
            : this.catalogFacade?.invalidateForWrite
              ? this.catalogFacade
              : undefined;
          if (invalidator?.invalidateForWrite && resolvedOwnerUserId) {
            await invalidator.invalidateForWrite({
              userId: resolvedOwnerUserId,
              projectId: ownerProjectId,
              itemIds: [attachment.itemId],
            });
            cacheInvalidated = true;
          }
        };

        if (hasAnyMutation) {
          itemMutated = true;
          if (this.libraryTx && resolvedOwnerUserId) {
            await executeWithPostCommit(
              this.libraryTx,
              async (tx, helpers) => {
                await runSideEffects(tx, true);
                const updatedItem = await this.extractionRepo.updateItem(
                  attachment.itemId,
                  itemPatch,
                  tx,
                );
                const domainSnapshot =
                  ItemsMapper.stripPersonalOverlayForSharedScope(
                    ItemsMapper.toDomain({
                      ...(attachment.item || {}),
                      ...updatedItem,
                    }),
                    ownerProjectId,
                  );
                await helpers.appendChange(eventScope, {
                  entityType: 'Item',
                  entityId: updatedItem.id,
                  action: 'update',
                  version: updatedItem.version,
                  data: domainSnapshot,
                });
                if (!options?.skipOutboxPublish) {
                  await helpers.publishOutbox(
                    eventScope,
                    updatedItem.id,
                    LIBRARY_EVENT_TYPES.ITEM_UPDATED,
                    {
                      itemId: updatedItem.id,
                      userId: resolvedOwnerUserId,
                      projectId: ownerProjectId,
                      attachmentId: attachment.id,
                      updatedFields: Object.keys(itemPatch),
                      updatedAt: new Date().toISOString(),
                      source: 'extraction.metadata_sync',
                    },
                  );
                  outboxPublished = true;
                }
              },
              () => invalidateSyncedItemCache(),
            );
          } else {
            await runSideEffects(undefined, true);
            await this.extractionRepo.updateItem(attachment.itemId, itemPatch);
            await invalidateSyncedItemCache();
          }
        }
      } catch (fulltextErr: unknown) {
        const message =
          fulltextErr instanceof Error
            ? fulltextErr.message
            : String(fulltextErr);
        this.logger.warn(
          `Failed to record extracted fulltext / backfill metadata for attachment ${attachment.id}: ${message}`,
        );
      }
    }
    return { outboxPublished, cacheInvalidated, itemMutated };
  }

  buildMetadataSyncPlan(
    attachment: ExtractionSyncAttachmentInput,
    doc: ExtractionSyncDocumentInput,
  ) {
    return buildExtractedMetadataSyncPlan(attachment, doc);
  }
}
