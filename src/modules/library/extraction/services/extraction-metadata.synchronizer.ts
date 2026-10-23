import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as zlib from 'zlib';
import { promisify } from 'util';
import { ExtractionRepository } from '@/modules/library/extraction/repositories/extraction.repository';
import { IStoragePort, STORAGE_PORT } from '@/modules/storage/storage.port';
import { parseCreatorString, isNoiseAuthorName } from '@/modules/library/core';

const gzipAsync = promisify(zlib.gzip);

@Injectable()
export class ExtractionMetadataSynchronizer {
  private readonly logger = new Logger(ExtractionMetadataSynchronizer.name);

  constructor(
    private readonly extractionRepo: ExtractionRepository,
    @Optional()
    @Inject(STORAGE_PORT)
    private readonly storagePort?: IStoragePort,
  ) {}

  /**
   * Offloads structured full-text tree to Object Storage (Claim Check pattern)
   * and synchronizes extracted metadata (DOI, arXiv, title, year, contributors, keywords, notes) onto Item model.
   */
  async offloadFullTextAndSyncMetadata(
    attachment: any,
    doc: any,
    extractionResult: any,
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
            ? doc.pages.map((p: any) => p.textContent || '').join('\n')
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
          doc.metadata?.publicationTitle ||
          doc.metadata?.journal ||
          doc.metadata?.proceedingsTitle ||
          doc.metadata?.conferenceName ||
          doc.metadata?.bookTitle ||
          (doc.metadata?.arxivId ? 'arXiv' : undefined);

        const shouldInferItemType =
          !attachment.item?.itemType ||
          attachment.item?.itemType === 'journalArticle' ||
          attachment.item?.itemType === 'document';

        const inferredItemType =
          doc.metadata?.proceedingsTitle || doc.metadata?.conferenceName
            ? 'conferencePaper'
            : doc.metadata?.arxivId && !doc.metadata?.journal && !doc.metadata?.proceedingsTitle
              ? 'preprint'
              : undefined;

        const existingItemRecord = (attachment.item ?? {}) as Record<
          string,
          unknown
        >;

        const itemPatch: Prisma.ItemUpdateInput = {
          ...(shouldInferItemType && inferredItemType ? { itemType: inferredItemType } : {}),
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
              ? doc.metadata.authors.map((name: string) => ({
                  fullName: name,
                }))
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
                  idx: number,
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
                    fullName: full || [first, last].filter(Boolean).join(' ') || 'Unknown Author',
                  };
                },
              )
              .filter(Boolean);

            if (validContributors.length > 0) {
              await this.extractionRepo.createContributors(
                validContributors as unknown as Prisma.ContributorCreateManyInput[],
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
}
