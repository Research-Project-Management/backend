import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as zlib from 'zlib';
import { promisify } from 'util';
import { ExtractionRepository } from '@/modules/library/extraction/repositories/extraction.repository';
import { IStoragePort, STORAGE_PORT } from '@/modules/storage/storage.port';
import {
  parseCreatorString,
  isNoiseAuthorName,
  LIBRARY_EVENT_TYPES,
  normalizeProjectScopeId,
} from '@/modules/library/core';
import { TransactionService } from '@/modules/library/sync';
import {
  ItemsMapper,
  ItemCacheCoordinator,
} from '@/modules/library/catalog';
import {
  buildExtractedMetadataSyncPlan,
  ExtractionSyncAttachmentInput,
  ExtractionSyncDocumentInput,
} from '@/modules/library/extraction/domain/extraction-metadata-merge.policy';

const gzipAsync = promisify(zlib.gzip);

@Injectable()
export class ExtractionMetadataSynchronizer {
  private readonly logger = new Logger(ExtractionMetadataSynchronizer.name);

  constructor(
    private readonly extractionRepo: ExtractionRepository,
    @Optional()
    private readonly libraryTx?: TransactionService,
    @Optional()
    @Inject(STORAGE_PORT)
    private readonly storagePort?: IStoragePort,
    @Optional()
    private readonly cacheCoordinator?: ItemCacheCoordinator,
  ) {}

  /**
   * Offloads structured full-text tree to Object Storage (Claim Check pattern)
   * and synchronizes extracted metadata (DOI, arXiv, title, year, contributors, keywords, notes) onto Item model.
   */
  async offloadFullTextAndSyncMetadata(
    attachment: Record<string, unknown> & { id: string; itemId: string; fileId?: string | null; metadata?: unknown; item?: Record<string, unknown> & { id?: string; userId?: string; projectId?: string | null; title?: string; doi?: string | null; arxivId?: string | null; abstract?: string | null; year?: number | null; metadata?: unknown; contributors?: unknown[]; itemTags?: unknown[]; notesList?: unknown[] } | null },
    doc: { references?: unknown[]; sections?: unknown[]; figures?: unknown[]; tables?: unknown[]; formulas?: unknown[]; fullText?: string; pages?: Array<{ textContent?: string }>; metadata?: { rawText?: string; keywords?: string[]; notes?: Array<{ content: string; type?: string }>; title?: string; doi?: string; arxivId?: string; abstract?: string; year?: number; numberOfPages?: number; publicationTitle?: string; journal?: string; proceedingsTitle?: string; conferenceName?: string; bookTitle?: string; isbn?: string; issn?: string; pmid?: string; volume?: string; issue?: string; pages?: string; publisher?: string; place?: string; publicationDate?: string; primaryCategory?: string; authors?: string[]; creators?: Array<{ creatorType?: string; fullName?: string; name?: string; firstName?: string; lastName?: string; fieldMode?: number }> } },
    extractionResult: { text?: string; sections?: unknown[]; figures?: unknown[]; tables?: unknown[]; formulas?: unknown[]; references?: unknown[]; markdown?: string; pageCount?: number; qualityScore?: number; engineUsed?: string },
    options?: { skipOutboxPublish?: boolean },
  ): Promise<{ outboxPublished: boolean }> {
    let outboxPublished = false;
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
        if (this.storagePort?.uploadFile) {
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
          this.storagePort?.deleteFile
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
        );

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

          if (creatorsToSync.length > 0) {
            const count = await this.extractionRepo.countContributors(
              attachment.itemId,
              tx,
            );
            if (count === 0) {
              const validContributors = creatorsToSync
                .map((c, idx) => {
                  const cand = c as {
                    creatorType?: string;
                    fullName?: string;
                    name?: string;
                    firstName?: string;
                    lastName?: string;
                    fieldMode?: number;
                  };
                  const itemCreatorType = cand.creatorType || primaryRole;
                  const rawName =
                    cand.fullName ||
                    cand.name ||
                    `${cand.firstName || ''} ${cand.lastName || ''}`.trim();
                  const parsed = parseCreatorString(
                    rawName,
                    idx,
                    itemCreatorType,
                  );
                  const first = (cand.firstName || parsed.firstName || '').trim();
                  const last = (cand.lastName || parsed.lastName || '').trim();
                  const full =
                    (cand.firstName || cand.lastName
                      ? cand.fullName ||
                        cand.name ||
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
                    fieldMode: cand.fieldMode ?? parsed.fieldMode ?? 0,
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
                  skipVersionIncrement ? { skipVersionIncrement: true } : undefined,
                );
              }
            }
          }

          if (tagsToSync.length > 0) {
            const tagCount = await this.extractionRepo.countItemTags(
              attachment.itemId,
              tx,
            );
            if (tagCount < 15) {
              const effectiveUserId = attachment.item?.userId || 'system';
              await this.extractionRepo.syncItemTags(
                {
                  userId: effectiveUserId,
                  itemId: attachment.itemId,
                  rawTags: tagsToSync.slice(0, Math.max(1, 25 - tagCount)),
                  projectId: attachment.item?.projectId,
                  ...(skipVersionIncrement ? { skipVersionIncrement: true } : {}),
                },
                tx,
              );
            }
          }

          if (notesToSync.length > 0) {
            const noteCount = await this.extractionRepo.countItemNotes(
              attachment.itemId,
              tx,
            );
            if (noteCount === 0) {
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
          }
        };

        const hasItemPatch = Object.keys(itemPatch).length > 0;
        const hasAnyMutation =
          hasItemPatch ||
          creatorsToSync.length > 0 ||
          extractedIdentifiers.length > 0 ||
          tagsToSync.length > 0 ||
          notesToSync.length > 0;

        const ownerUserId = attachment.item?.userId || 'system';
        const ownerProjectId = normalizeProjectScopeId(
          attachment.item?.projectId,
        );
        const eventScope = {
          userId: ownerUserId,
          projectId: ownerProjectId,
        };

        if (hasAnyMutation) {
          if (this.libraryTx && ownerUserId) {
            await this.libraryTx.executeInTransaction(async (tx, helpers) => {
              await runSideEffects(tx, true);
              const updatedItem = await this.extractionRepo.updateItem(
                attachment.itemId,
                itemPatch,
                tx,
              );
              const domainSnapshot = ItemsMapper.toDomain({
                ...(attachment.item || {}),
                ...updatedItem,
              });
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
                    userId: ownerUserId,
                    projectId: ownerProjectId,
                    attachmentId: attachment.id,
                    updatedAt: new Date().toISOString(),
                    source: 'extraction.metadata_sync',
                  },
                );
                outboxPublished = true;
              }
            });
          } else {
            await runSideEffects(undefined, true);
            await this.extractionRepo.updateItem(attachment.itemId, itemPatch);
          }

          if (this.cacheCoordinator && ownerUserId) {
            await this.cacheCoordinator.invalidateForWrite({
              userId: ownerUserId,
              projectId: ownerProjectId,
              itemIds: [attachment.itemId],
            });
          }
        } else if (!options?.skipOutboxPublish && this.libraryTx && ownerUserId) {
          await this.libraryTx.executeInTransaction(async (_tx, helpers) => {
            await helpers.publishOutbox(
              eventScope,
              attachment.itemId,
              LIBRARY_EVENT_TYPES.ITEM_UPDATED,
              {
                itemId: attachment.itemId,
                userId: ownerUserId,
                projectId: ownerProjectId,
                attachmentId: attachment.id,
                updatedAt: new Date().toISOString(),
                source: 'extraction.metadata_sync',
              },
            );
            outboxPublished = true;
          });
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
    return { outboxPublished };
  }

  buildMetadataSyncPlan(
    attachment: ExtractionSyncAttachmentInput,
    doc: ExtractionSyncDocumentInput,
  ) {
    return buildExtractedMetadataSyncPlan(attachment, doc);
  }
}
