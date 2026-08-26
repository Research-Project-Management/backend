import { PrismaClient } from '@prisma/client';
import { Logger } from '@nestjs/common';
import {
  normalizeDoi,
  normalizeArxivId,
  normalizePmid,
  normalizePmcid,
  normalizeIsbn,
  normalizeIssn,
  formatCanonicalId,
} from '@/modules/library/metadata/utils/metadata.util';
import { extractFamilyName } from '@/modules/library/cite/utils/cite.util';


type CanonicalIdentifierType = 'doi' | 'arxiv' | 'pmid' | 'pmcid' | 'isbn' | 'issn';


/**
 * Idempotent Data Backfill Script for Normalized Library Metadata (Phase 2)
 *
 * Populates normalized relational tables from existing legacy CatalogItem columns:
 * 1. CatalogContributor (authors & editors)
 * 2. CatalogIdentifier (DOI, arXiv, PMID, PMCID, ISBN, ISSN)
 * 3. CollectionItem (M:N collection links from collectionId)
 * 4. CatalogTag & CatalogItemTag (normalized workspace labels)
 * 5. CatalogItemRevision (initial baseline revision snapshot)
 */
export async function backfillLibraryMetadata(prisma: PrismaClient) {
  const logger = new Logger('BackfillLibraryMetadata');
  logger.log('Starting normalized library metadata backfill...');

  const batchSize = 100;
  let skip = 0;
  let totalProcessed = 0;

  while (true) {
    const items = await prisma.catalogItem.findMany({
      skip,
      take: batchSize,
      orderBy: { createdAt: 'asc' },
    });

    if (!items || items.length === 0) {
      break;
    }

    for (const item of items) {
      await prisma.$transaction(async (tx) => {
        // ── 1. Backfill Contributors ───────────────────────────────────────────
        if (Array.isArray(item.authors)) {
          for (let i = 0; i < item.authors.length; i++) {
            const rawAuthor = item.authors[i]?.trim();
            if (!rawAuthor) continue;

            const existing = await tx.catalogContributor.findFirst({
              where: {
                catalogItemId: item.id,
                fullName: rawAuthor,
                creatorType: 'author',
              },
            });

            if (!existing) {
              const family = extractFamilyName(rawAuthor);
              const given =
                family && rawAuthor.includes(',')
                  ? rawAuthor.split(',')[1]?.trim()
                  : '';

              await tx.catalogContributor.create({
                data: {
                  catalogItemId: item.id,
                  creatorType: 'author',
                  fullName: rawAuthor,
                  lastName: family || rawAuthor,
                  firstName: given || '',
                  orderIndex: i,
                },
              });
            }
          }
        }

        if (Array.isArray(item.editors)) {
          for (let i = 0; i < item.editors.length; i++) {
            const rawEditor = item.editors[i]?.trim();
            if (!rawEditor) continue;

            const existing = await tx.catalogContributor.findFirst({
              where: {
                catalogItemId: item.id,
                fullName: rawEditor,
                creatorType: 'editor',
              },
            });

            if (!existing) {
              await tx.catalogContributor.create({
                data: {
                  catalogItemId: item.id,
                  creatorType: 'editor',
                  fullName: rawEditor,
                  orderIndex: i,
                },
              });
            }
          }
        }

        // ── 2. Backfill Identifiers ────────────────────────────────────────────
        const idMap: {
          type: string;
          value?: string | null;
          normalizer: (v: string) => string | undefined;
        }[] = [
          { type: 'DOI', value: item.doi, normalizer: normalizeDoi },
          { type: 'PMID', value: item.pmid, normalizer: normalizePmid },
          { type: 'PMCID', value: item.pmcid, normalizer: normalizePmcid },
          { type: 'ISBN', value: item.isbn, normalizer: normalizeIsbn },
          { type: 'ISSN', value: item.issn, normalizer: normalizeIssn },
        ];

        for (const entry of idMap) {
          if (!entry.value || !entry.value.trim()) continue;
          const normalized =
            entry.normalizer(entry.value) || entry.value.trim();

          const existing = await tx.catalogIdentifier.findFirst({
            where: {
              catalogItemId: item.id,
              type: entry.type,
              value: normalized,
            },
          });

          if (!existing) {
            const canonicalUri = formatCanonicalId(
              entry.type.toLowerCase() as CanonicalIdentifierType,
              normalized,
            );
            await tx.catalogIdentifier.create({
              data: {
                catalogItemId: item.id,
                type: entry.type,
                value: normalized,
                canonicalUri,
              },
            });
          }
        }

        // ── 3. Backfill CollectionItem (M:N) ───────────────────────────────────
        if (item.collectionId) {
          const existingColItem = await tx.collectionItem.findUnique({
            where: {
              collectionId_catalogItemId: {
                collectionId: item.collectionId,
                catalogItemId: item.id,
              },
            },
          });

          if (!existingColItem) {
            await tx.collectionItem.create({
              data: {
                collectionId: item.collectionId,
                catalogItemId: item.id,
                sortOrder: 0,
              },
            });
          }
        }

        // ── 4. Backfill Tags (CatalogTag & CatalogItemTag) ─────────────────────
        if (Array.isArray(item.labels)) {
          for (const labelName of item.labels) {
            const cleanLabel = labelName?.trim();
            if (!cleanLabel) continue;

            const tag = await tx.catalogTag.upsert({
              where: {
                workspaceId_name: {
                  workspaceId: item.workspaceId,
                  name: cleanLabel,
                },
              },
              update: {},
              create: {
                workspaceId: item.workspaceId,
                name: cleanLabel,
                color: '#3b82f6',
                type: 'manual',
              },
            });

            const existingItemTag = await tx.catalogItemTag.findUnique({
              where: {
                tagId_catalogItemId: {
                  tagId: tag.id,
                  catalogItemId: item.id,
                },
              },
            });

            if (!existingItemTag) {
              await tx.catalogItemTag.create({
                data: {
                  tagId: tag.id,
                  catalogItemId: item.id,
                },
              });
            }
          }
        }

        // ── 5. Backfill Initial Revision ───────────────────────────────────────
        const existingRev = await tx.catalogItemRevision.findFirst({
          where: {
            catalogItemId: item.id,
            version: 1,
          },
        });

        if (!existingRev) {
          await tx.catalogItemRevision.create({
            data: {
              catalogItemId: item.id,
              version: 1,
              changesSnapshot: {
                title: item.title,
                authors: item.authors,
                year: item.year,
                doi: item.doi,
                itemType: item.itemType,
                journal: item.journal,
                citationKey: item.citationKey,
              },
              changedById: item.uploadedById,
            },
          });
        }
      });
    }

    totalProcessed += items.length;
    skip += batchSize;
    logger.log(`Backfilled ${totalProcessed} library items so far...`);
  }

  logger.log(
    `Library metadata backfill finished successfully. Total items processed: ${totalProcessed}`,
  );
  return totalProcessed;
}
