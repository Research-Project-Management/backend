import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as zlib from 'zlib';
import { promisify } from 'util';
import { ExtractionRepository } from '@/modules/library/extraction/repositories/extraction.repository';
import { IStoragePort, STORAGE_PORT } from '@/modules/storage/storage.port';
import {
  parseCreatorString,
  isNoiseAuthorName,
  normalizeDoi,
  normalizeArxivId,
  normalizePmid,
  normalizePmcid,
  normalizeIsbn,
  normalizeIssn,
  generateCitationKey,
  getPrimaryCreatorRoleForType,
  isPlaceholderItemTitle,
  sanitizeItemTitle,
  cleanAbstractText,
  harmonizeZoteroFields,
  LIBRARY_EVENT_TYPES,
  normalizeProjectScopeId,
  ItemProvenancePolicy,
  inferItemTypeFromPdfSignals,
} from '@/modules/library/core';
import { TransactionService } from '@/modules/library/sync';
import {
  ItemsMapper,
  ItemCacheCoordinator,
} from '@/modules/library/catalog';

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
  ): Promise<void> {
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
                  const itemCreatorType = c.creatorType || primaryRole;
                  const rawName =
                    c.fullName ||
                    c.name ||
                    `${c.firstName || ''} ${c.lastName || ''}`.trim();
                  const parsed = parseCreatorString(
                    rawName,
                    idx,
                    itemCreatorType,
                  );
                  const first = (c.firstName || parsed.firstName || '').trim();
                  const last = (c.lastName || parsed.lastName || '').trim();
                  const full =
                    (c.firstName || c.lastName
                      ? c.fullName ||
                        c.name ||
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
                    fieldMode: c.fieldMode ?? parsed.fieldMode ?? 0,
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
            if (tagCount === 0) {
              const effectiveUserId = attachment.item?.userId || 'system';
              await this.extractionRepo.syncItemTags(
                {
                  userId: effectiveUserId,
                  itemId: attachment.itemId,
                  rawTags: tagsToSync,
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

        if (hasAnyMutation) {
          const ownerUserId = attachment.item?.userId || 'system';
          const ownerProjectId = normalizeProjectScopeId(
            attachment.item?.projectId,
          );
          const eventScope = {
            userId: ownerUserId,
            projectId: ownerProjectId,
          };

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
                    updatedAt: new Date().toISOString(),
                    source: 'extraction.metadata_sync',
                  },
                );
              }
            });
          } else {
            await runSideEffects();
            if (hasItemPatch) {
              await this.extractionRepo.updateItem(attachment.itemId, itemPatch);
            }
          }

          if (this.cacheCoordinator && ownerUserId) {
            await this.cacheCoordinator.invalidateForWrite({
              userId: ownerUserId,
              projectId: ownerProjectId,
              itemIds: [attachment.itemId],
            });
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
  }

  buildMetadataSyncPlan(
    attachment: Record<string, unknown> & {
      id: string; itemId: string;
      item?: (Record<string, unknown> & {
        id?: string; userId?: string; projectId?: string | null; title?: string;
        doi?: string | null; arxivId?: string | null; abstract?: string | null;
        year?: number | null; publicationTitle?: string | null; itemType?: string | null; metadata?: unknown;
      }) | null;
    },
    doc: {
      references?: unknown[];
      metadata?: {
        keywords?: string[]; notes?: Array<{ content: string; type?: string }>;
        title?: string; doi?: string; arxivId?: string; abstract?: string; year?: number;
        numberOfPages?: number; publicationTitle?: string; journal?: string; proceedingsTitle?: string;
        conferenceName?: string; bookTitle?: string; isbn?: string; issn?: string; pmid?: string;
        pmcid?: string; volume?: string; issue?: string; pages?: string; publisher?: string;
        place?: string; publicationDate?: string; primaryCategory?: string; authors?: string[];
        creators?: Array<{ creatorType?: string; fullName?: string; name?: string; firstName?: string; lastName?: string; fieldMode?: number }>;
      };
    },
  ) {
    const currentTitle = String(attachment.item?.title || '').trim();
    const cleanedExtractedTitle = doc.metadata?.title
      ? sanitizeItemTitle(doc.metadata.title) || doc.metadata.title.trim()
      : undefined;
    const shouldUpdateTitle = Boolean(
      cleanedExtractedTitle && isPlaceholderItemTitle(currentTitle),
    );
    const cleanedExtractedAbstract = doc.metadata?.abstract
      ? cleanAbstractText(doc.metadata.abstract) ?? doc.metadata.abstract.trim()
      : undefined;

    const existingMeta =
      typeof attachment.item?.metadata === 'object' && attachment.item?.metadata !== null && !Array.isArray(attachment.item?.metadata)
        ? (attachment.item.metadata as Record<string, unknown>) : {};
    const { provenanceMap: existingFieldProv } =
      ItemProvenancePolicy.extractProvenanceState(attachment.item ?? existingMeta);
    const isLocked = (fieldKey: string) =>
      ItemProvenancePolicy.isFieldLocked(attachment.item ?? existingMeta, fieldKey);

    const metaPatch: Record<string, unknown> = {};
    if (doc.references && doc.references.length > 0) metaPatch.referenceCount = doc.references.length;
    if (doc.metadata?.arxivId && !existingMeta.arxivId && !isLocked('arxivId')) metaPatch.arxivId = doc.metadata.arxivId;

    const backfillKeys = [
      'isbn', 'issn', 'pmid', 'pmcid', 'volume', 'issue', 'pages', 'publisher',
      'place', 'conferenceName', 'bookTitle', 'publicationDate', 'numberOfPages', 'primaryCategory',
    ] as const;
    for (const key of backfillKeys) {
      const val = doc.metadata?.[key];
      if (!isLocked(key) && val !== undefined && val !== null && val !== '' && (existingMeta[key] === undefined || existingMeta[key] === null || existingMeta[key] === '')) {
        metaPatch[key] = val;
      }
    }

    const fallbackPubTitle =
      doc.metadata?.publicationTitle || doc.metadata?.journal || doc.metadata?.proceedingsTitle ||
      doc.metadata?.conferenceName || doc.metadata?.bookTitle || (doc.metadata?.arxivId ? 'arXiv' : undefined);

    const shouldInferItemType =
      !isLocked('itemType') && (!attachment.item?.itemType || attachment.item?.itemType === 'journalArticle' || attachment.item?.itemType === 'document');
    const pdfSignalInference = shouldInferItemType
      ? inferItemTypeFromPdfSignals({
          title: cleanedExtractedTitle || doc.metadata?.title || attachment.item?.title,
          notes: doc.metadata?.notes,
          conferenceName: doc.metadata?.conferenceName || doc.metadata?.proceedingsTitle,
          bookTitle: doc.metadata?.bookTitle,
          isbn: doc.metadata?.isbn,
          publisher: doc.metadata?.publisher,
          journal: doc.metadata?.journal || doc.metadata?.publicationTitle,
        })
      : undefined;
    const inferredItemType =
      doc.metadata?.proceedingsTitle || doc.metadata?.conferenceName
        ? 'conferencePaper'
        : doc.metadata?.arxivId && !doc.metadata?.journal && !doc.metadata?.proceedingsTitle
          ? 'preprint'
          : pdfSignalInference?.itemType;
    const effectiveItemType =
      shouldInferItemType && inferredItemType ? inferredItemType : String(attachment.item?.itemType || 'journalArticle');

    if (shouldInferItemType && inferredItemType) {
      metaPatch.itemType = inferredItemType;
      if (inferredItemType === 'preprint' && !isLocked('repository')) {
        metaPatch.repository = doc.metadata?.publicationTitle || doc.metadata?.journal || existingMeta.repository || 'arXiv';
      } else if (inferredItemType === 'conferencePaper' && !existingMeta.proceedingsTitle && !isLocked('proceedingsTitle')) {
        metaPatch.proceedingsTitle = doc.metadata?.proceedingsTitle || doc.metadata?.conferenceName || fallbackPubTitle;
      }
    }

    const existingItemRecord = (attachment.item ?? {}) as Record<string, unknown>;
    const existingItemMeta =
      typeof existingItemRecord.metadata === 'object' && existingItemRecord.metadata !== null && !Array.isArray(existingItemRecord.metadata)
        ? (existingItemRecord.metadata as Record<string, unknown>) : existingMeta;

    const idNormalizers = { arxivId: normalizeArxivId, pmid: normalizePmid, pmcid: normalizePmcid, isbn: normalizeIsbn, issn: normalizeIssn } as const;
    const extractedIdentifiers: Array<{ type: string; value: string; canonicalUri: string }> = [];
    const cleanExtractedDoi = doc.metadata?.doi ? normalizeDoi(doc.metadata.doi) || doc.metadata.doi : undefined;
    if (cleanExtractedDoi && !attachment.item?.doi && !isLocked('doi')) {
      metaPatch.doi = cleanExtractedDoi;
      extractedIdentifiers.push({ type: 'doi', value: cleanExtractedDoi, canonicalUri: `https://doi.org/${cleanExtractedDoi}` });
    }
    const effectiveUpdateTitle = shouldUpdateTitle && !isLocked('title');
    if (effectiveUpdateTitle && cleanedExtractedTitle) metaPatch.title = cleanedExtractedTitle;

    let hasBackfilledFields = Object.keys(metaPatch).length > 0;
    for (const idKey of ['arxivId', 'pmid', 'pmcid', 'isbn', 'issn'] as const) {
      const extractedVal = doc.metadata?.[idKey];
      if (!isLocked(idKey) && extractedVal && !existingItemMeta[idKey] && !existingItemRecord[idKey]) {
        const normVal = idNormalizers[idKey](extractedVal) || extractedVal;
        metaPatch[idKey] = normVal;
        hasBackfilledFields = true;
        const uriMap: Record<typeof idKey, string> = {
          arxivId: `https://arxiv.org/abs/${normVal}`,
          pmid: `https://pubmed.ncbi.nlm.nih.gov/${normVal}/`,
          pmcid: `https://www.ncbi.nlm.nih.gov/pmc/articles/${normVal}/`,
          isbn: `urn:isbn:${normVal}`,
          issn: `urn:issn:${normVal}`,
        };
        extractedIdentifiers.push({ type: idKey === 'arxivId' ? 'arxiv' : idKey, value: normVal, canonicalUri: uriMap[idKey] });
      }
    }

    if (!isLocked('abstract') && !isLocked('abstractNote') && !attachment.item?.abstract && cleanedExtractedAbstract && !existingItemMeta.abstractNote) {
      metaPatch.abstractNote = cleanedExtractedAbstract;
      hasBackfilledFields = true;
    }
    if (!isLocked('publicationTitle') && !attachment.item?.publicationTitle && fallbackPubTitle && !existingItemMeta.publicationTitle) {
      metaPatch.publicationTitle = fallbackPubTitle;
      if (effectiveItemType === 'conferencePaper' && !existingItemMeta.proceedingsTitle && !isLocked('proceedingsTitle')) {
        metaPatch.proceedingsTitle = doc.metadata?.proceedingsTitle || fallbackPubTitle;
      }
      hasBackfilledFields = true;
    }
    if (!isLocked('year') && !isLocked('date') && !isLocked('publicationDate') && !attachment.item?.year && doc.metadata?.year && !existingItemMeta.date && !existingItemMeta.publicationDate) {
      metaPatch.date = doc.metadata.publicationDate || String(doc.metadata.year);
      metaPatch.publicationDate = doc.metadata.publicationDate || String(doc.metadata.year);
      hasBackfilledFields = true;
    }

    if (hasBackfilledFields) {
      const harmonizedDelta = harmonizeZoteroFields(
        { ...metaPatch, itemType: effectiveItemType },
        { itemType: effectiveItemType, syncExtraFields: false, syncLegacyAliases: false },
      );
      for (const [k, v] of Object.entries(harmonizedDelta)) {
        if (isLocked(k)) continue;
        if (k === 'itemType' && metaPatch.itemType === undefined) continue;
        if (k === 'abstract' && metaPatch.abstractNote !== undefined && metaPatch.abstract === undefined) continue;
        if (k === 'numPages' && metaPatch.numberOfPages !== undefined && metaPatch.numPages === undefined) continue;
        if (k === 'archiveId' && metaPatch.arxivId !== undefined && metaPatch.archiveId === undefined) continue;
        if (
          v !== undefined &&
          metaPatch[k] === undefined &&
          (existingItemMeta[k] === undefined || existingItemMeta[k] === null || existingItemMeta[k] === '')
        ) {
          metaPatch[k] = v;
        }
      }
      const nextProv: Record<string, unknown> = { ...existingFieldProv };
      for (const patchedKey of Object.keys(metaPatch)) {
        if (patchedKey === 'referenceCount' || patchedKey === 'fieldProvenance' || patchedKey === 'lockedFields') continue;
        if (!nextProv[patchedKey]) {
          nextProv[patchedKey] = {
            source: 'LocalPDFExtraction',
            sourceProvider: 'LocalPDFExtraction',
            confidence: 0.82,
            verified: true,
          };
        }
      }
      metaPatch.fieldProvenance = nextProv;
    }

    const primaryRole = getPrimaryCreatorRoleForType(effectiveItemType);
    const creatorsToSync: Array<{
      creatorType?: string;
      fullName?: string;
      name?: string;
      firstName?: string;
      lastName?: string;
      fieldMode?: number;
    }> =
      isLocked('creators') || isLocked('authors')
        ? []
        : doc.metadata?.creators && doc.metadata.creators.length > 0
          ? doc.metadata.creators
          : doc.metadata?.authors && doc.metadata.authors.length > 0
            ? doc.metadata.authors.map((name: string) => ({ fullName: name })) : [];

    const existingCitKey = String(existingItemRecord.citationKey || '').trim();
    const needsCitationKeyRegen = !isLocked('citationKey') && (!existingCitKey || /^anon/i.test(existingCitKey));
    const resolvedTitle = effectiveUpdateTitle ? cleanedExtractedTitle : currentTitle;
    const resolvedYear = (attachment.item?.year as number | undefined) || doc.metadata?.year;
    const firstCreatorCandidate = creatorsToSync[0];
    const firstCreatorRaw = firstCreatorCandidate
      ? firstCreatorCandidate.lastName || firstCreatorCandidate.fullName || firstCreatorCandidate.name || '' : '';
    const regeneratedCitKey =
      needsCitationKeyRegen && (effectiveUpdateTitle || firstCreatorRaw || resolvedYear)
        ? generateCitationKey({
            authors: firstCreatorRaw ? [firstCreatorRaw] : undefined,
            year: resolvedYear ?? null,
            title: resolvedTitle || 'Untitled',
          })
        : undefined;
    if (regeneratedCitKey && !/^anon/i.test(regeneratedCitKey)) {
      metaPatch.citationKey = regeneratedCitKey;
      hasBackfilledFields = true;
    }

    const { tags: _omitTags, keywords: _omitKeywords, ...existingItemMetaWithoutTags } = existingItemMeta;
    const itemPatch: Prisma.ItemUpdateInput = {
      ...(shouldInferItemType && inferredItemType ? { itemType: inferredItemType } : {}),
      ...(effectiveUpdateTitle ? { title: cleanedExtractedTitle } : {}),
      ...(regeneratedCitKey && !/^anon/i.test(regeneratedCitKey) ? { citationKey: regeneratedCitKey } : {}),
      ...(!isLocked('doi') && !attachment.item?.doi && cleanExtractedDoi ? { doi: cleanExtractedDoi } : {}),
      ...(!isLocked('abstract') && !isLocked('abstractNote') && !attachment.item?.abstract && cleanedExtractedAbstract ? { abstract: cleanedExtractedAbstract } : {}),
      ...(!isLocked('year') && !isLocked('date') && !isLocked('publicationDate') && !attachment.item?.year && doc.metadata?.year ? { year: doc.metadata.year } : {}),
      ...(!isLocked('publicationTitle') && !isLocked('journal') && !attachment.item?.publicationTitle && fallbackPubTitle ? { publicationTitle: fallbackPubTitle } : {}),
      ...(hasBackfilledFields ? { metadata: { ...existingItemMetaWithoutTags, ...metaPatch } as unknown as Prisma.InputJsonValue } : {}),
    };

    const tagsToSync = !isLocked('tags') && Array.isArray(doc.metadata?.keywords) ? doc.metadata.keywords : [];
    const notesToSync = Array.isArray(doc.metadata?.notes) ? doc.metadata.notes : [];

    return { itemPatch, metaPatch, extractedIdentifiers, creatorsToSync, primaryRole, tagsToSync, notesToSync };
  }
}
