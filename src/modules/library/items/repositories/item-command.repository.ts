import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { Prisma, RagStatus } from '@prisma/client';
import { PrismaService } from '../../../../core/database/prisma.service';
import { VersionMismatchException } from '../../common/errors/version-mismatch.exception';
import { normalizeTags } from '../../tags/utils/tags.utils';
import {
  parseCreatorString,
  normalizeDoi,
  normalizeArxivId,
  normalizePmid,
  normalizePmcid,
  normalizeIsbn,
  normalizeIssn,
  cleanBannedString,
} from '../utils/items.utils';
import { getFileContentPath } from '@/modules/storage/storage.port';
import {
  TYPE_SPECIFIC_EXTRA_FIELDS,
  parseAccessDate,
} from '../constants/items.constants';
import {
  CreateCatalogItemData,
  UpdateCatalogItemData,
} from '../types/items.types';


@Injectable()
export class ItemCommandRepository {
  constructor(private readonly prisma: PrismaService) {}

  private getClient(tx?: Prisma.TransactionClient) {
    return tx ?? this.prisma;
  }

  async create(
    workspaceId: string,
    data: CreateCatalogItemData,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    const resolvedFileId =
      data.fileId ||
      data.fileUrl?.match(/\/api\/files\/([a-zA-Z0-9-]+)\/content/)?.[1] ||
      null;
    const notes = Array.isArray(data.notes)
      ? data.notes
          .map((note) => {
            const content =
              typeof note === 'string' ? note : (note as { content?: unknown })?.content;
            const source =
              typeof note === 'object' && note
                ? (note as { source?: unknown }).source
                : undefined;
            const contentMd = typeof content === 'string' ? content.trim() : '';
            if (!contentMd) return null;
            const sourceName = typeof source === 'string' ? source.trim() : '';
            return {
              workspaceId,
              createdById: data.uploadedById || 'system',
              title: sourceName ? `Imported Note (${sourceName})` : 'Imported Note',
              contentMd,
              contentJson: {
                type: 'doc',
                content: [{ type: 'paragraph', text: contentMd }],
              },
              tags: ['imported', ...(sourceName ? [sourceName] : [])],
              version: 1,
            };
          })
          .filter((note): note is NonNullable<typeof note> => note !== null)
      : [];
    const cleanDoi =
      normalizeDoi(cleanBannedString(data.doi)) ||
      cleanBannedString(data.doi) ||
      '';
    const cleanArxivId =
      normalizeArxivId(cleanBannedString(data.arxivId)) ||
      cleanBannedString(data.arxivId) ||
      '';
    const cleanPmid =
      normalizePmid(cleanBannedString(data.pmid)) ||
      cleanBannedString(data.pmid) ||
      '';
    const cleanPmcid =
      normalizePmcid(cleanBannedString(data.pmcid)) ||
      cleanBannedString(data.pmcid) ||
      '';
    const cleanIsbn =
      normalizeIsbn(cleanBannedString(data.isbn)) ||
      cleanBannedString(data.isbn) ||
      '';
    const cleanIssn =
      normalizeIssn(cleanBannedString(data.issn)) ||
      cleanBannedString(data.issn) ||
      '';

    const createData: Prisma.CatalogItemUncheckedCreateInput = {
      workspaceId,
      title: data.title,
      year: data.year ?? null,
      doi: cleanDoi,
      abstract: data.abstract ?? '',
      itemType: data.itemType ?? 'journalArticle',
      publicationTitle: data.publicationTitle ?? data.journal ?? '',
      publicationDate:
        data.publicationDate ?? (data.year ? String(data.year) : ''),
      publisher: data.publisher ?? '',
      place: data.place ?? '',
      volume: data.volume ?? '',
      issue: data.issue ?? '',
      section: data.section ?? '',
      partNumber: data.partNumber ?? '',
      partTitle: data.partTitle ?? '',
      pages: data.pages ?? '',
      series: data.series ?? '',
      seriesTitle: data.seriesTitle ?? '',
      seriesText: data.seriesText ?? '',
      issn: cleanIssn,
      isbn: cleanIsbn,
      pmid: cleanPmid,
      pmcid: cleanPmcid,
      url: data.url ?? '',
      language: data.language ?? '',
      journalAbbr: data.journalAbbr ?? '',
      shortTitle: data.shortTitle ?? '',
      rights: data.rights ?? '',
      license: data.license ?? '',
      citationKey: data.citationKey ?? '',
      libraryCatalog: data.libraryCatalog ?? '',
      archive: data.archive ?? '',
      archiveLocation: data.archiveLocation ?? '',
      callNumber: data.callNumber ?? '',
      accessedAt: data.accessedAt ?? parseAccessDate(data.accessDate) ?? null,
      arxivId: cleanArxivId || undefined,
      citationCount: data.citationCount ?? null,
      referenceCount: data.referenceCount ?? null,
      openAccessPdfUrl: data.openAccessPdfUrl ?? null,
      seriesNumber: data.seriesNumber ?? null,
      extra: (() => {
        // Merge extra (raw text/JSON), extraFields, and type-specific fields that have no dedicated DB column
        let merged: Record<string, any> = {};
        let rawExtraPreserved = false;
        if (typeof data.extra === 'string' && data.extra.trim()) {
          if (data.extra.trim().startsWith('{')) {
            try {
              merged = JSON.parse(data.extra);
            } catch {
              // Non-JSON extra: preserve as _rawExtra so it is not lost
              merged._rawExtra = data.extra;
              rawExtraPreserved = true;
            }
          } else {
            // Plain text extra (e.g. Zotero "Citations: 23526") — preserve unconditionally
            merged._rawExtra = data.extra;
            rawExtraPreserved = true;
          }
        }
        if (
          data.extraFields &&
          typeof data.extraFields === 'object' &&
          Object.keys(data.extraFields).length > 0
        ) {
          merged = { ...merged, ...data.extraFields };
        }
        // Capture type-specific fields that have no dedicated DB column
        for (const key of TYPE_SPECIFIC_EXTRA_FIELDS) {
          const value = (data as unknown as Record<string, unknown>)[key];

          if (value !== undefined && value !== '') {
            merged[key] = value;
          }
        }
        // If we only have the raw extra and nothing else merged, return raw text as-is
        const mergedKeys = Object.keys(merged);
        if (
          mergedKeys.length === 1 &&
          rawExtraPreserved &&
          mergedKeys[0] === '_rawExtra'
        ) {
          return data.extra ?? '';
        }
        if (mergedKeys.length > 0) return JSON.stringify(merged);
        return data.extra ?? '';
      })(),
      uploadedById: data.uploadedById || 'system',
      version: 1,
      ...(() => {
        const rawCollectionIds = [
          ...(Array.isArray(data.collectionIds) ? data.collectionIds : []),
          ...(data.collectionId ? [data.collectionId] : []),
        ].filter(
          (id): id is string => typeof id === 'string' && id.trim().length > 0,
        );
        const uniqueCollectionIds = Array.from(new Set(rawCollectionIds));
        if (uniqueCollectionIds.length > 0) {
          return {
            collectionItems: {
              create: uniqueCollectionIds.map((cid, idx) => ({
                collectionId: cid,
                sortOrder: idx,
              })),
            },
          };
        }
        return {};
      })(),
      ...(data.contributors
        ? {
            contributors: data.contributors,
          }
        : data.creators && data.creators.length > 0
          ? {
              contributors: {
                create: data.creators.map((c: any, index: number) => ({
                  creatorType: c.creatorType || 'author',
                  firstName: c.firstName || '',
                  lastName: c.lastName || '',
                  fullName:
                    c.fullName ||
                    [c.firstName, c.lastName].filter(Boolean).join(' ') ||
                    c.name ||
                    '',
                  orderIndex: c.orderIndex !== undefined ? c.orderIndex : index,
                })),
              },
            }
          : data.authors && data.authors.length > 0
            ? {
                contributors: {
                  create: data.authors.map(
                    (authorName: string, index: number) => {
                      const parsed = parseCreatorString(authorName, index);
                      return {
                        creatorType: parsed.creatorType,
                        firstName: parsed.firstName,
                        lastName: parsed.lastName,
                        fullName: parsed.fullName,
                        orderIndex: parsed.orderIndex,
                      };
                    },
                  ),
                },
              }
            : {}),
      ...(cleanDoi ||
      cleanArxivId ||
      cleanPmid ||
      cleanPmcid ||
      cleanIsbn ||
      cleanIssn
        ? {
            identifiers: {
              create: [
                ...(cleanDoi
                  ? [
                      {
                        type: 'doi',
                        value: cleanDoi,
                        canonicalUri: `https://doi.org/${cleanDoi}`,
                      },
                    ]
                  : []),
                ...(cleanArxivId
                  ? [
                      {
                        type: 'arxiv',
                        value: cleanArxivId,
                        canonicalUri: `https://arxiv.org/abs/${cleanArxivId}`,
                      },
                    ]
                  : []),
                ...(cleanPmid
                  ? [
                      {
                        type: 'pmid',
                        value: cleanPmid,
                        canonicalUri: `https://pubmed.ncbi.nlm.nih.gov/${cleanPmid}/`,
                      },
                    ]
                  : []),
                ...(cleanPmcid
                  ? [
                      {
                        type: 'pmcid',
                        value: cleanPmcid,
                        canonicalUri: `https://www.ncbi.nlm.nih.gov/pmc/articles/${cleanPmcid}/`,
                      },
                    ]
                  : []),
                ...(cleanIsbn
                  ? [
                      {
                        type: 'isbn',
                        value: cleanIsbn,
                        canonicalUri: `urn:isbn:${cleanIsbn}`,
                      },
                    ]
                  : []),
                ...(cleanIssn
                  ? [
                      {
                        type: 'issn',
                        value: cleanIssn,
                        canonicalUri: `urn:issn:${cleanIssn}`,
                      },
                    ]
                  : []),
              ],
            },
          }
        : {}),
      ...(data.tags?.length || data.keywords?.length || data.labels?.length
        ? {
            itemTags: {
              create: normalizeTags([
                ...(data.tags || []),
                ...(data.keywords || []),
                ...(data.labels || []),
              ])
                .slice(0, 30)
                .map((tagName) => ({
                  tag: {
                    connectOrCreate: {
                      where: {
                        workspaceId_name: {
                          workspaceId,
                          name: tagName,
                        },
                      },
                      create: {
                        workspaceId,
                        name: tagName,
                      },
                    },
                  },
                })),
            },
          }
        : {}),
      ...(data.fileUrl || resolvedFileId
        ? {
            attachments: {
              create: [
                {
                  filename: data.filename || 'document.pdf',
                  url:
                    data.fileUrl ||
                    (resolvedFileId ? getFileContentPath(resolvedFileId) : ''),
                  fileId: resolvedFileId,
                  size: data.size || 0,
                  mimeType: data.mimeType || 'application/pdf',
                  attachmentType: 'primary_pdf',
                  revisions: {
                    create: [
                      {
                        revisionNumber: 1,
                        url:
                          data.fileUrl ||
                          (resolvedFileId
                            ? getFileContentPath(resolvedFileId)
                            : ''),
                        sizeBytes: data.size || 0,
                        fileHash: '',
                      },
                    ],
                  },
                },
              ],
            },
          }
        : {}),
      ...(notes.length > 0
        ? {
            notesList: {
              create: notes,
            },
          }
        : {}),
    };

    const item = await client.catalogItem.create({
      data: createData,
      include: {
        collectionItems: {
          include: { collection: true },
        },
        itemTags: {
          include: { tag: true },
        },
        contributors: {
          orderBy: { orderIndex: 'asc' },
        },
        identifiers: true,
        attachments: true,
      },
    });

    if (resolvedFileId && client.file?.updateMany) {
      await client.file.updateMany({
        where: { id: resolvedFileId },
        data: {
          linkedToType: 'Paper',
          linkedToId: item.id,
        },
      });
    }
    return item;
  }

  async update(
    workspaceId: string,
    id: string,
    expectedVersion: number | undefined,
    data: UpdateCatalogItemData,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    const existing = await client.catalogItem.findFirst({
      where: { id, workspaceId, deletedAt: null },
      include: {
        identifiers: true,
      },
    });

    if (!existing) {
      throw new NotFoundException(
        `CatalogItem ${id} not found in workspace ${workspaceId}`,
      );
    }

    if (expectedVersion !== undefined && existing.version !== expectedVersion) {
      throw new VersionMismatchException({
        aggregateType: 'CatalogItem',
        entityId: id,
        currentVersion: existing.version,
        providedVersion: expectedVersion,
      });
    }

    const cleanDoi =
      data.doi !== undefined
        ? normalizeDoi(cleanBannedString(data.doi)) ||
          cleanBannedString(data.doi) ||
          ''
        : undefined;
    const cleanArxivId =
      data.arxivId !== undefined
        ? normalizeArxivId(cleanBannedString(data.arxivId)) ||
          cleanBannedString(data.arxivId) ||
          ''
        : undefined;
    const cleanPmid =
      data.pmid !== undefined
        ? normalizePmid(cleanBannedString(data.pmid)) ||
          cleanBannedString(data.pmid) ||
          ''
        : undefined;
    const cleanPmcid =
      data.pmcid !== undefined
        ? normalizePmcid(cleanBannedString(data.pmcid)) ||
          cleanBannedString(data.pmcid) ||
          ''
        : undefined;
    const cleanIsbn =
      data.isbn !== undefined
        ? normalizeIsbn(cleanBannedString(data.isbn)) ||
          cleanBannedString(data.isbn) ||
          ''
        : undefined;
    const cleanIssn =
      data.issn !== undefined
        ? normalizeIssn(cleanBannedString(data.issn)) ||
          cleanBannedString(data.issn) ||
          ''
        : undefined;

    const updated = await client.catalogItem.update({
      where: { id },
      data: {
        title: data.title ?? existing.title,
        year: data.year !== undefined ? data.year : existing.year,
        doi: cleanDoi !== undefined ? cleanDoi : existing.doi,
        abstract: data.abstract ?? existing.abstract,
        itemType: data.itemType ?? existing.itemType,
        publicationTitle:
          data.publicationTitle ?? data.journal ?? existing.publicationTitle,

        publicationDate: data.publicationDate ?? existing.publicationDate,
        publisher: data.publisher ?? existing.publisher,
        place: data.place ?? existing.place,
        volume: data.volume ?? existing.volume,
        issue: data.issue ?? existing.issue,
        section: data.section ?? existing.section,
        partNumber: data.partNumber ?? existing.partNumber,
        partTitle: data.partTitle ?? existing.partTitle,
        pages: data.pages ?? existing.pages,
        series: data.series ?? existing.series,
        seriesTitle: data.seriesTitle ?? existing.seriesTitle,
        seriesText: data.seriesText ?? existing.seriesText,
        issn: cleanIssn !== undefined ? cleanIssn : existing.issn,
        isbn: cleanIsbn !== undefined ? cleanIsbn : existing.isbn,
        pmid: cleanPmid !== undefined ? cleanPmid : existing.pmid,
        pmcid: cleanPmcid !== undefined ? cleanPmcid : existing.pmcid,
        url: data.url ?? existing.url,
        language: data.language ?? existing.language,
        journalAbbr: data.journalAbbr ?? existing.journalAbbr,
        shortTitle: data.shortTitle ?? existing.shortTitle,
        rights: data.rights ?? existing.rights,
        license: data.license ?? existing.license,
        citationKey: data.citationKey ?? existing.citationKey,
        libraryCatalog: data.libraryCatalog ?? existing.libraryCatalog,
        archive: data.archive ?? existing.archive,
        archiveLocation: data.archiveLocation ?? existing.archiveLocation,
        callNumber: data.callNumber ?? existing.callNumber,
        accessedAt:
          data.accessedAt !== undefined
            ? data.accessedAt
            : (parseAccessDate(data.accessDate) ?? existing.accessedAt),
        arxivId: cleanArxivId !== undefined ? cleanArxivId : existing.arxivId,
        citationCount: data.citationCount !== undefined ? data.citationCount : existing.citationCount,
        referenceCount: data.referenceCount !== undefined ? data.referenceCount : existing.referenceCount,
        openAccessPdfUrl: data.openAccessPdfUrl !== undefined ? data.openAccessPdfUrl : existing.openAccessPdfUrl,
        seriesNumber: data.seriesNumber !== undefined ? data.seriesNumber : existing.seriesNumber,
        extra: (() => {
          // Build merged extraFields: start from existing, overlay incoming extraFields, then type-specific fields
          let merged: Record<string, any> = {};
          let existingIsPlainText = false;
          if (existing.extra && existing.extra.trim()) {
            if (existing.extra.trim().startsWith('{')) {
              try {
                merged = JSON.parse(existing.extra);
              } catch {
                // Existing extra is non-JSON plain text — preserve it
                merged._rawExtra = existing.extra;
                existingIsPlainText = true;
              }
            } else {
              // Plain text (Zotero style) — preserve unconditionally
              merged._rawExtra = existing.extra;
              existingIsPlainText = true;
            }
          }
          // Incoming extra (from update payload) may override
          if (typeof data.extra === 'string' && data.extra.trim()) {
            if (data.extra.trim().startsWith('{')) {
              try {
                const incomingParsed = JSON.parse(data.extra);
                merged = { ...merged, ...incomingParsed };
                // Incoming is valid JSON — clear plain-text guard if it existed
                existingIsPlainText = false;
              } catch {
                merged._rawExtra = data.extra;
                existingIsPlainText = true;
              }
            } else {
              merged._rawExtra = data.extra;
              existingIsPlainText = true;
            }
          }
          if (data.extraFields && typeof data.extraFields === 'object') {
            merged = { ...merged, ...data.extraFields };
            existingIsPlainText = false; // structured extraFields always win
          }
          // Merge type-specific fields that have no dedicated DB column
          for (const key of TYPE_SPECIFIC_EXTRA_FIELDS) {
            const value = (data as Record<string, unknown>)[key];
            if (value !== undefined) {
              merged[key] = value;
              existingIsPlainText = false;
            }
          }
          // If only _rawExtra key present and no structured data, return plain text
          const mergedKeys = Object.keys(merged);
          if (
            existingIsPlainText &&
            mergedKeys.length === 1 &&
            mergedKeys[0] === '_rawExtra'
          ) {
            return merged._rawExtra;
          }
          return mergedKeys.length > 0
            ? JSON.stringify(merged)
            : (data.extra ?? existing.extra ?? '');
        })(),

        ...(data.collectionIds !== undefined
          ? {
              collectionItems: (() => {
                const raw = Array.isArray(data.collectionIds)
                  ? data.collectionIds
                  : [];
                const unique = Array.from(
                  new Set(
                    raw.filter(
                      (cid): cid is string =>
                        typeof cid === 'string' && cid.trim().length > 0,
                    ),
                  ),
                );
                return unique.length > 0
                  ? {
                      deleteMany: {},
                      create: unique.map((cid, idx) => ({
                        collectionId: cid,
                        sortOrder: idx,
                      })),
                    }
                  : {
                      deleteMany: {},
                    };
              })(),
            }
          : data.collectionId !== undefined
            ? {
                collectionItems:
                  data.collectionId !== null &&
                  typeof data.collectionId === 'string' &&
                  data.collectionId.trim().length > 0
                    ? {
                        deleteMany: {},
                        create: {
                          collectionId: data.collectionId.trim(),
                          sortOrder: 0,
                        },
                      }
                    : {
                        deleteMany: {},
                      },
              }
            : {}),
        ...(data.creators !== undefined
          ? {
              contributors: {
                deleteMany: {},
                create: (data.creators || []).map((c: any, index: number) => ({
                  creatorType: c.creatorType || 'author',
                  firstName: c.firstName || '',
                  lastName: c.lastName || '',
                  fullName:
                    c.fullName ||
                    [c.firstName, c.lastName].filter(Boolean).join(' ') ||
                    c.name ||
                    '',
                  orderIndex: c.orderIndex !== undefined ? c.orderIndex : index,
                })),
              },
            }
          : data.authors !== undefined
            ? {
                contributors: {
                  deleteMany: {},
                  create: (data.authors || []).map(
                    (authorName: string, index: number) => {
                      const parsed = parseCreatorString(authorName, index);
                      return {
                        creatorType: parsed.creatorType,
                        firstName: parsed.firstName,
                        lastName: parsed.lastName,
                        fullName: parsed.fullName,
                        orderIndex: parsed.orderIndex,
                      };
                    },
                  ),
                },
              }
            : {}),
        version: { increment: 1 },
      },
      include: {
        collectionItems: {
          include: { collection: true },
        },
        itemTags: {
          include: { tag: true },
        },
        contributors: {
          orderBy: { orderIndex: 'asc' },
        },
        identifiers: true,
        attachments: {
          include: { revisions: true },
        },
        notesList: {
          where: { deletedAt: null },
        },
      },
    });

    // Sync identifiers table when DOI/arXiv/PMID/PMCID/ISBN/ISSN change
    const identifierChanges: Array<{
      type: string;
      value: string;
      canonicalUri: string;
    }> = [];
    if (cleanDoi !== undefined && cleanDoi !== existing.doi) {
      identifierChanges.push({
        type: 'doi',
        value: cleanDoi,
        canonicalUri: cleanDoi ? `https://doi.org/${cleanDoi}` : '',
      });
    }
    const existingArxivIdentifier = existing.identifiers?.find(
      (identifierItem) => identifierItem.type === 'arxiv',
    )?.value;
    if (
      cleanArxivId !== undefined &&
      cleanArxivId !== existingArxivIdentifier
    ) {
      identifierChanges.push({
        type: 'arxiv',
        value: cleanArxivId,
        canonicalUri: cleanArxivId
          ? `https://arxiv.org/abs/${cleanArxivId}`
          : '',
      });
    }
    if (cleanPmid !== undefined && cleanPmid !== existing.pmid) {
      identifierChanges.push({
        type: 'pmid',
        value: cleanPmid,
        canonicalUri: cleanPmid
          ? `https://pubmed.ncbi.nlm.nih.gov/${cleanPmid}/`
          : '',
      });
    }
    if (cleanPmcid !== undefined && cleanPmcid !== existing.pmcid) {
      identifierChanges.push({
        type: 'pmcid',
        value: cleanPmcid,
        canonicalUri: cleanPmcid
          ? `https://www.ncbi.nlm.nih.gov/pmc/articles/${cleanPmcid}/`
          : '',
      });
    }
    if (cleanIsbn !== undefined && cleanIsbn !== existing.isbn) {
      identifierChanges.push({
        type: 'isbn',
        value: cleanIsbn,
        canonicalUri: cleanIsbn ? `urn:isbn:${cleanIsbn}` : '',
      });
    }
    if (cleanIssn !== undefined && cleanIssn !== existing.issn) {
      identifierChanges.push({
        type: 'issn',
        value: cleanIssn,
        canonicalUri: cleanIssn ? `urn:issn:${cleanIssn}` : '',
      });
    }
    for (const ident of identifierChanges) {
      await client.catalogIdentifier.deleteMany({
        where: { catalogItemId: updated.id, type: ident.type },
      });
      if (ident.value) {
        await client.catalogIdentifier.create({
          data: {
            catalogItemId: updated.id,
            type: ident.type,
            value: ident.value,
            canonicalUri: ident.canonicalUri || undefined,
          },
        });
      }
    }

    const rawTags = data.tags || data.keywords || data.labels;
    if (rawTags && Array.isArray(rawTags)) {
      const normalizedTagsList = normalizeTags(rawTags);
      if (normalizedTagsList.length === 0) {
        await client.catalogItemTag.deleteMany({
          where: { catalogItemId: updated.id },
        });
      } else {
        await client.catalogItemTag.deleteMany({
          where: {
            catalogItemId: updated.id,
            tag: {
              name: { notIn: normalizedTagsList },
            },
          },
        });
        for (const tagName of normalizedTagsList) {
          const tag = await client.catalogTag.upsert({
            where: {
              workspaceId_name: {
                workspaceId,
                name: tagName,
              },
            },
            create: {
              workspaceId,
              name: tagName,
            },
            update: {},
          });
          await client.catalogItemTag.upsert({
            where: {
              tagId_catalogItemId: {
                tagId: tag.id,
                catalogItemId: updated.id,
              },
            },
            create: {
              tagId: tag.id,
              catalogItemId: updated.id,
            },
            update: {},
          });
        }
      }

      const reloaded = await client.catalogItem.findUnique({
        where: { id: updated.id },
        include: {
          collectionItems: {
            include: { collection: true },
          },
          itemTags: {
            include: { tag: true },
          },
          contributors: {
            orderBy: { orderIndex: 'asc' },
          },
          identifiers: true,
          attachments: true,
          notesList: {
            where: { deletedAt: null },
          },
        },
      });
      return reloaded || updated;
    }

    return updated;
  }

  async softDelete(
    workspaceId: string,
    id: string,
    expectedVersion?: number,
    tx?: Prisma.TransactionClient,
  ): Promise<boolean> {
    const client = this.getClient(tx);
    if (expectedVersion !== undefined) {
      const existing = await client.catalogItem.findFirst({
        where: { id, workspaceId, deletedAt: null },
      });
      if (existing && existing.version !== expectedVersion) {
        throw new VersionMismatchException({
          aggregateType: 'CatalogItem',
          entityId: id,
          currentVersion: existing.version,
          providedVersion: expectedVersion,
        });
      }
    }

    const result = await client.catalogItem.updateMany({
      where: { id, workspaceId, deletedAt: null },
      data: { deletedAt: new Date() },
    });

    return result.count > 0;
  }

  async restore(
    workspaceId: string,
    id: string,
    expectedVersion?: number,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    const existing = await client.catalogItem.findFirst({
      where: { id, workspaceId, deletedAt: { not: null } },
    });

    if (!existing) {
      throw new NotFoundException(
        `Trashed item ${id} not found in workspace ${workspaceId}`,
      );
    }

    // Protection against restoring merged items
    let extraObj: any = {};
    try {
      extraObj = existing.extra ? JSON.parse(existing.extra) : {};
    } catch {
      extraObj = {};
    }

    if (extraObj.mergedIntoId) {
      throw new BadRequestException(
        `Cannot restore item ${id}: it was merged into primary item ${extraObj.mergedIntoId}`,
      );
    }

    if (expectedVersion !== undefined && existing.version !== expectedVersion) {
      throw new VersionMismatchException({
        aggregateType: 'CatalogItem',
        entityId: id,
        currentVersion: existing.version,
        providedVersion: expectedVersion,
      });
    }

    return client.catalogItem.update({
      where: { id },
      data: {
        deletedAt: null,
        version: { increment: 1 },
      },
      include: {
        contributors: { orderBy: { orderIndex: 'asc' } },
        identifiers: true,
        collectionItems: { include: { collection: true } },
        itemTags: { include: { tag: true } },
        notesList: { where: { deletedAt: null } },
        attachments: { include: { revisions: true } },
      },
    });
  }

  async purge(
    workspaceId: string,
    id: string,
    tx?: Prisma.TransactionClient,
  ): Promise<boolean> {
    const client = this.getClient(tx);
    const existing = await client.catalogItem.findFirst({
      where: { id, workspaceId },
    });

    if (!existing) {
      throw new NotFoundException(
        `Item ${id} not found in workspace ${workspaceId}`,
      );
    }

    if (!existing.deletedAt) {
      throw new BadRequestException(
        `Item ${id} must be in trash before it can be permanently purged`,
      );
    }

    await client.catalogItem.delete({
      where: { id },
    });

    return true;
  }

  async putRelation(
    itemId: string,
    relation: any,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const client = this.getClient(tx);
    const targetItemId = relation.targetItemId || relation.targetId;
    if (!targetItemId) return;

    const source = await client.catalogItem.findUnique({
      where: { id: itemId },
      select: { workspaceId: true },
    });
    if (!source) return;

    await client.itemRelation.upsert({
      where: {
        sourceItemId_targetItemId_relationType: {
          sourceItemId: itemId,
          targetItemId,
          relationType: relation.relationType || 'cites',
        },
      },
      create: {
        workspaceId: source.workspaceId,
        sourceItemId: itemId,
        targetItemId,
        relationType: relation.relationType || 'cites',
        description: relation.description || '',
      },
      update: {
        description: relation.description || '',
      },
    });
  }

  async removeRelation(
    itemId: string,
    targetItemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const client = this.getClient(tx);
    await client.itemRelation.deleteMany({
      where: {
        sourceItemId: itemId,
        targetItemId,
      },
    });

    const item = await client.catalogItem.findUnique({
      where: { id: itemId },
      select: { extra: true },
    });
    if (item?.extra) {
      try {
        const extraObj = JSON.parse(item.extra);
        if (Array.isArray(extraObj.relations)) {
          extraObj.relations = extraObj.relations.filter(
            (r: any) => (r.targetItemId || r.targetId) !== targetItemId,
          );
          await client.catalogItem.update({
            where: { id: itemId },
            data: { extra: JSON.stringify(extraObj) },
          });
        }
      } catch (_err) {
        // ignore malformed JSON extra
      }
    }
  }

  async updateRagStatus(
    id: string,
    data: {
      ragStatus?: RagStatus;
      ragDocId?: string;
      ragIndexedAt?: Date;
      ragLastAttemptAt?: Date;
      ragError?: string | null;
    },
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    return client.catalogItem.update({
      where: { id },
      data,
    });
  }
}
