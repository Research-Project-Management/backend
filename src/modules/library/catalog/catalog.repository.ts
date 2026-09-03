import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../../core/database/prisma.service';
import { Prisma } from '@prisma/client';
import { VersionMismatchException } from './errors/catalog.errors';
import { normalizeTags } from '../tags/utils/tags.utils';
import { parseCreatorString } from './migrations/backfill-creators';
import { CatalogItemSummary } from './types/catalog.types';
import { getFileContentPath } from '../../storage/storage.port';

export interface CreateCatalogItemData {
  title: string;
  authors?: string[];
  year?: number | null;
  doi?: string;
  abstract?: string;
  itemType?: string;
  editors?: string[];
  journal?: string;
  publicationTitle?: string;
  publicationDate?: string;
  publisher?: string;
  place?: string;
  volume?: string;
  issue?: string;
  section?: string;
  partNumber?: string;
  partTitle?: string;
  pages?: string;
  series?: string;
  seriesTitle?: string;
  seriesText?: string;
  seriesNumber?: string;
  issn?: string;
  isbn?: string;
  pmid?: string;
  pmcid?: string;
  url?: string;
  type?: string;
  language?: string;
  journalAbbr?: string;
  shortTitle?: string;
  rights?: string;
  license?: string;
  citationKey?: string;
  libraryCatalog?: string;
  archive?: string;
  archiveLocation?: string;
  callNumber?: string;
  accessedAt?: Date | null;
  extra?: string;
  notes?: any;
  labels?: string[];
  keywords?: string[];
  fileUrl?: string;
  fileId?: string;
  filename?: string;
  mimeType?: string;

  size?: number;
  collectionId?: string | null;
  uploadedById: string;
  contributors?: any;
  creators?: any[];
  extraFields?: Record<string, any>;
  arxivId?: string;
  citationCount?: number | null;
  influentialCitationCount?: number | null;
}

export interface UpdateCatalogItemData {
  title?: string;
  authors?: string[];
  creators?: any[];
  extraFields?: Record<string, any>;
  year?: number | null;
  doi?: string;
  arxivId?: string;
  abstract?: string;
  abstractNote?: string;
  itemType?: string;
  editors?: string[];
  journal?: string;
  publicationTitle?: string;
  publicationDate?: string;
  publisher?: string;
  place?: string;
  volume?: string;
  issue?: string;
  section?: string;
  partNumber?: string;
  partTitle?: string;
  pages?: string;
  series?: string;
  seriesTitle?: string;
  seriesText?: string;
  seriesNumber?: string;
  issn?: string;
  isbn?: string;
  pmid?: string;
  pmcid?: string;
  url?: string;
  type?: string;
  language?: string;
  journalAbbr?: string;
  shortTitle?: string;
  rights?: string;
  license?: string;
  citationKey?: string;
  citationCount?: number | null;
  influentialCitationCount?: number | null;
  libraryCatalog?: string;
  archive?: string;
  archiveLocation?: string;
  callNumber?: string;
  accessedAt?: Date | null;
  extra?: string;
  notes?: any;
  labels?: string[];
  keywords?: string[];
  tags?: string[];
  collectionId?: string | null;
  // Type-specific fields (stored in extraFields if no dedicated column)
  edition?: string;
  numPages?: string;
  numberOfVolumes?: string;
  bookTitle?: string;
  proceedingsTitle?: string;
  conferenceName?: string;
  eventPlace?: string;
  websiteTitle?: string;
  websiteType?: string;
  university?: string;
  institution?: string;
  country?: string;
  assignee?: string;
  issuingAuthority?: string;
  patentNumber?: string;
  applicationNumber?: string;
  reportNumber?: string;
  reportType?: string;
  thesisType?: string;
  genre?: string;
  filingDate?: string;
  legalStatus?: string;
  versionNumber?: string;
  blogTitle?: string;
  forumTitle?: string;
  postType?: string;
  presentationType?: string;
  meetingName?: string;
  letterType?: string;
  manuscriptType?: string;
  mapType?: string;
  artworkMedium?: string;
  artworkSize?: string;
  distributor?: string;
  runningTime?: string;
  programTitle?: string;
  episodeNumber?: string;
  podcastType?: string;
  interviewMedium?: string;
  dictionaryTitle?: string;
  encyclopediaTitle?: string;
  originalDate?: string;
  originalPublisher?: string;
  originalPlace?: string;
  court?: string;
  docketNumber?: string;
  firstPage?: string;
  dateDecided?: string;
  reporter?: string;
  reporterVolume?: string;
  codeNumber?: string;
  publicLawNumber?: string;
  dateEnacted?: string;
  billNumber?: string;
  legislativeBody?: string;
  programmingLanguage?: string;
  standardNumber?: string;
}

@Injectable()
export class CatalogRepository {
  constructor(private readonly prisma: PrismaService) {}

  private getClient(tx?: Prisma.TransactionClient) {
    return tx ?? this.prisma;
  }

  async findById(
    workspaceId: string,
    id: string,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    return client.catalogItem.findFirst({
      where: { id, workspaceId, deletedAt: null },
      include: {
        contributors: {
          orderBy: { orderIndex: 'asc' },
        },
        identifiers: true,
        collectionItems: {
          include: { collection: true },
        },
        itemTags: {
          include: { tag: true },
        },
        notesList: {
          where: { deletedAt: null },
        },
        attachments: {
          include: { revisions: true },
        },
        mergeLineages: true,
      },
    });
  }

  async findByIds(
    workspaceId: string,
    ids: string[],
    tx?: Prisma.TransactionClient,
  ) {
    if (!ids || ids.length === 0) return [];
    const client = this.getClient(tx);
    return client.catalogItem.findMany({
      where: {
        id: { in: ids },
        workspaceId,
        deletedAt: null,
      },
      include: {
        contributors: {
          orderBy: { orderIndex: 'asc' },
        },
        identifiers: true,
        collectionItems: {
          include: { collection: true },
        },
        itemTags: {
          include: { tag: true },
        },
        attachments: {
          include: { revisions: true },
        },
      },
    });
  }

  async findByDoi(
    workspaceId: string,
    doi: string,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    return client.catalogItem.findFirst({
      where: {
        workspaceId,
        doi,
        deletedAt: null,
      },
      include: {
        contributors: {
          orderBy: { orderIndex: 'asc' },
        },
        identifiers: true,
        collectionItems: {
          include: { collection: true },
        },
        itemTags: {
          include: { tag: true },
        },
        attachments: {
          include: { revisions: true },
        },
      },
    });
  }

  async findMany(
    workspaceId: string,
    options: {
      view?: 'all' | 'recent' | 'unfiled' | 'trash';
      userId?: string;
      collectionId?: string;
      tagId?: string;
      search?: string;
      limit?: number;
      cursor?: string;
    },
    tx?: Prisma.TransactionClient,
  ): Promise<any[]> {
    const client = this.getClient(tx);
    const view = options.view ?? 'all';
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);

    const itemInclude = {
      contributors: {
        orderBy: { orderIndex: 'asc' as const },
      },
      identifiers: true,
      collectionItems: {
        include: { collection: true },
      },
      itemTags: {
        include: { tag: true },
      },
      notesList: {
        where: { deletedAt: null },
      },
      attachments: {
        include: { revisions: true },
      },
      userStates: options.userId
        ? {
            where: { userId: options.userId },
          }
        : false,
    };

    if (view === 'recent' && options.userId) {
      // For recent view, cursor-based pagination uses itemId (catalogItem.id).
      // Since userItemState has no unique constraint on itemId alone, we resolve
      // the cursor to a lastReadAt timestamp and use that for keyset pagination.
      let cursorLastReadAt: Date | undefined;
      if (options.cursor) {
        const cursorState = await client.userItemState.findFirst({
          where: { userId: options.userId, itemId: options.cursor },
          select: { lastReadAt: true },
        });
        cursorLastReadAt = cursorState?.lastReadAt ?? undefined;
      }

      const userStates = await client.userItemState.findMany({
        where: {
          userId: options.userId,
          lastReadAt: cursorLastReadAt
            ? { not: null, lt: cursorLastReadAt }
            : { not: null },
          item: {
            workspaceId,
            deletedAt: null,
            ...(options.search
              ? {
                  OR: [
                    {
                      title: { contains: options.search, mode: 'insensitive' },
                    },
                    {
                      abstract: {
                        contains: options.search,
                        mode: 'insensitive',
                      },
                    },
                    { doi: { contains: options.search, mode: 'insensitive' } },
                  ],
                }
              : {}),
            ...(options.collectionId
              ? {
                  collectionItems: {
                    some: { collectionId: options.collectionId },
                  },
                }
              : {}),
            ...(options.tagId
              ? {
                  itemTags: {
                    some: { tagId: options.tagId },
                  },
                }
              : {}),
          },
        },
        include: {
          item: {
            include: itemInclude,
          },
        },
        orderBy: {
          lastReadAt: 'desc',
        },
        take: limit + 1,
      });

      return userStates
        .filter((us) => Boolean(us.item))
        .map((us) => ({
          ...us.item,
          lastReadAt: us.lastReadAt,
        }));
    }

    return client.catalogItem.findMany({
      where: this.buildWhereClause(workspaceId, options),
      take: limit + 1,
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
      orderBy: { createdAt: 'desc' },
      include: itemInclude,
    });
  }

  /**
   * Builds a shared CatalogItem WHERE clause from the common filter options.
   * Used by both findMany and count to avoid duplicated logic.
   */
  private buildWhereClause(
    workspaceId: string,
    options: {
      view?: 'all' | 'recent' | 'unfiled' | 'trash';
      collectionId?: string;
      tagId?: string;
      search?: string;
    },
  ): Prisma.CatalogItemWhereInput {
    const view = options.view ?? 'all';
    const where: Prisma.CatalogItemWhereInput = { workspaceId };

    if (view === 'trash') {
      where.deletedAt = { not: null };
    } else {
      where.deletedAt = null;
      if (view === 'unfiled') {
        where.collectionItems = { none: {} };
      }
    }

    if (options.collectionId) {
      where.collectionItems = { some: { collectionId: options.collectionId } };
    }

    if (options.tagId) {
      where.itemTags = { some: { tagId: options.tagId } };
    }

    if (options.search) {
      where.OR = [
        { title: { contains: options.search, mode: 'insensitive' } },
        { abstract: { contains: options.search, mode: 'insensitive' } },
        { doi: { contains: options.search, mode: 'insensitive' } },
      ];
    }

    return where;
  }

  async count(
    workspaceId: string,
    options: {
      view?: 'all' | 'recent' | 'unfiled' | 'trash';
      userId?: string;
      collectionId?: string;
      tagId?: string;
      search?: string;
    },
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const client = this.getClient(tx);
    const view = options.view ?? 'all';

    if (view === 'recent' && options.userId) {
      return client.userItemState.count({
        where: {
          userId: options.userId,
          lastReadAt: { not: null },
          item: {
            workspaceId,
            deletedAt: null,
            ...(options.search
              ? {
                  OR: [
                    {
                      title: { contains: options.search, mode: 'insensitive' },
                    },
                    {
                      abstract: {
                        contains: options.search,
                        mode: 'insensitive',
                      },
                    },
                    { doi: { contains: options.search, mode: 'insensitive' } },
                  ],
                }
              : {}),
            ...(options.collectionId
              ? {
                  collectionItems: {
                    some: { collectionId: options.collectionId },
                  },
                }
              : {}),
            ...(options.tagId
              ? {
                  itemTags: {
                    some: { tagId: options.tagId },
                  },
                }
              : {}),
          },
        },
      });
    }

    return client.catalogItem.count({
      where: this.buildWhereClause(workspaceId, options),
    });
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
    const createData: Prisma.CatalogItemUncheckedCreateInput = {
      workspaceId,
      title: data.title,
      year: data.year ?? null,
      doi: data.doi ?? '',
      abstract: data.abstract ?? '',
      itemType: data.itemType ?? 'journalArticle',
      publicationTitle: data.publicationTitle ?? (data as any).journal ?? '',
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
      issn: data.issn ?? '',
      isbn: data.isbn ?? '',
      pmid: data.pmid ?? '',
      pmcid: data.pmcid ?? '',
      url: data.url ?? '',
      type: data.type ?? '',
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
      accessedAt: data.accessedAt ?? null,
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
        const typeSpecificKeys = [
          'seriesNumber',
          'abstractNote',
          'edition',
          'numPages',
          'numberOfVolumes',
          'bookTitle',
          'proceedingsTitle',
          'conferenceName',
          'eventPlace',
          'websiteTitle',
          'websiteType',
          'university',
          'institution',
          'country',
          'assignee',
          'issuingAuthority',
          'patentNumber',
          'applicationNumber',
          'reportNumber',
          'reportType',
          'thesisType',
          'genre',
          'filingDate',
          'legalStatus',
          'versionNumber',
        ] as const;
        for (const key of typeSpecificKeys) {
          if ((data as any)[key] !== undefined && (data as any)[key] !== '') {
            merged[key] = (data as any)[key];
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
      ...(data.collectionId
        ? {
            collectionItems: {
              create: {
                collectionId: data.collectionId,
                sortOrder: 0,
              },
            },
          }
        : {}),
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
      ...(data.doi || data.arxivId || data.pmid || data.isbn
        ? {
            identifiers: {
              create: [
                ...(data.doi && data.doi.trim()
                  ? [
                      {
                        type: 'doi',
                        value: data.doi.trim(),
                        canonicalUri: `https://doi.org/${data.doi.trim()}`,
                      },
                    ]
                  : []),
                ...(data.arxivId && data.arxivId.trim()
                  ? [
                      {
                        type: 'arxiv',
                        value: data.arxivId.trim(),
                        canonicalUri: `https://arxiv.org/abs/${data.arxivId.trim()}`,
                      },
                    ]
                  : []),
                ...(data.pmid && data.pmid.trim()
                  ? [
                      {
                        type: 'pmid',
                        value: data.pmid.trim(),
                        canonicalUri: `https://pubmed.ncbi.nlm.nih.gov/${data.pmid.trim()}/`,
                      },
                    ]
                  : []),
                ...(data.isbn && data.isbn.trim()
                  ? [
                      {
                        type: 'isbn',
                        value: data.isbn.trim(),
                        canonicalUri: `urn:isbn:${data.isbn.trim()}`,
                      },
                    ]
                  : []),
              ],
            },
          }
        : {}),
      ...((data as any).labels?.length ||
      (data as any).keywords?.length ||
      (data as any).tags?.length
        ? {
            itemTags: {
              create: Array.from(
                new Set(
                  [
                    ...((data as any).labels || []),
                    ...((data as any).keywords || []),
                    ...((data as any).tags || []),
                  ].filter(
                    (t): t is string =>
                      typeof t === 'string' && t.trim().length > 0,
                  ),
                ),
              )
                .slice(0, 30)
                .map((name) => ({
                  tag: {
                    connectOrCreate: {
                      where: {
                        workspaceId_name: {
                          workspaceId,
                          name,
                        },
                      },
                      create: {
                        workspaceId,
                        name,
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

    const rawTags = (data as any).tags || data.keywords || data.labels || [];
    const normalizedTagsList = normalizeTags(rawTags);
    if (normalizedTagsList.length > 0) {
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
              catalogItemId: item.id,
            },
          },
          create: {
            tagId: tag.id,
            catalogItemId: item.id,
          },
          update: {},
        });
      }

      const reloaded = await client.catalogItem.findUnique({
        where: { id: item.id },
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
        },
      });

      return reloaded || item;
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

    const updated = await client.catalogItem.update({
      where: { id },
      data: {
        title: data.title ?? existing.title,
        year: data.year !== undefined ? data.year : existing.year,
        doi: data.doi ?? existing.doi,
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
        issn: data.issn ?? existing.issn,
        isbn: data.isbn ?? existing.isbn,
        pmid: data.pmid ?? existing.pmid,
        pmcid: data.pmcid ?? existing.pmcid,
        url: data.url ?? existing.url,
        type: data.type ?? existing.type,
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
          data.accessedAt !== undefined ? data.accessedAt : existing.accessedAt,
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
          const typeSpecificFields: (keyof UpdateCatalogItemData)[] = [
            'edition',
            'numPages',
            'numberOfVolumes',
            'bookTitle',
            'proceedingsTitle',
            'conferenceName',
            'eventPlace',
            'websiteTitle',
            'websiteType',
            'university',
            'institution',
            'country',
            'assignee',
            'issuingAuthority',
            'patentNumber',
            'applicationNumber',
            'reportNumber',
            'reportType',
            'thesisType',
            'genre',
            'filingDate',
            'legalStatus',
            'versionNumber',
            'blogTitle',
            'forumTitle',
            'postType',
            'presentationType',
            'meetingName',
            'letterType',
            'manuscriptType',
            'mapType',
            'artworkMedium',
            'artworkSize',
            'distributor',
            'runningTime',
            'programTitle',
            'episodeNumber',
            'podcastType',
            'interviewMedium',
            'dictionaryTitle',
            'encyclopediaTitle',
            'originalDate',
            'originalPublisher',
            'originalPlace',
            'court',
            'docketNumber',
            'firstPage',
            'dateDecided',
            'reporter',
            'reporterVolume',
            'codeNumber',
            'publicLawNumber',
            'dateEnacted',
            'billNumber',
            'legislativeBody',
            'programmingLanguage',
            'standardNumber',
            'abstractNote',
          ];
          for (const key of typeSpecificFields) {
            if (data[key] !== undefined) {
              merged[key] = data[key];
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

        ...(data.collectionId !== undefined
          ? {
              collectionItems:
                data.collectionId !== null
                  ? {
                      deleteMany: {},
                      create: {
                        collectionId: data.collectionId,
                        sortOrder: 0,
                      },
                    }
                  : {
                      deleteMany: {},
                    },
            }
          : {}),
        ...(data.creators && data.creators.length > 0
          ? {
              contributors: {
                deleteMany: {},
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
                  deleteMany: {},
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

    // ── Sync identifiers table when DOI/arXiv/PMID/PMCID/ISBN/ISSN change ──────
    // We replace each identifier type individually so we never drop identifiers
    // belonging to other types that were not part of this update payload.
    const identifierChanges: Array<{
      type: string;
      value: string;
      canonicalUri: string;
    }> = [];
    if (data.doi !== undefined && data.doi !== existing.doi) {
      identifierChanges.push({
        type: 'doi',
        value: (data.doi ?? '').trim(),
        canonicalUri: data.doi ? `https://doi.org/${data.doi.trim()}` : '',
      });
    }
    if (
      data.arxivId !== undefined &&
      data.arxivId !== (existing as any).arxivId
    ) {
      identifierChanges.push({
        type: 'arxiv',
        value: (data.arxivId ?? '').trim(),
        canonicalUri: data.arxivId
          ? `https://arxiv.org/abs/${data.arxivId.trim()}`
          : '',
      });
    }
    if (data.pmid !== undefined && data.pmid !== existing.pmid) {
      identifierChanges.push({
        type: 'pmid',
        value: (data.pmid ?? '').trim(),
        canonicalUri: data.pmid
          ? `https://pubmed.ncbi.nlm.nih.gov/${data.pmid.trim()}/`
          : '',
      });
    }
    if (data.pmcid !== undefined && data.pmcid !== existing.pmcid) {
      identifierChanges.push({
        type: 'pmcid',
        value: (data.pmcid ?? '').trim(),
        canonicalUri: data.pmcid
          ? `https://www.ncbi.nlm.nih.gov/pmc/articles/${data.pmcid.trim()}/`
          : '',
      });
    }
    if (data.isbn !== undefined && data.isbn !== existing.isbn) {
      identifierChanges.push({
        type: 'isbn',
        value: (data.isbn ?? '').trim(),
        canonicalUri: data.isbn ? `urn:isbn:${data.isbn.trim()}` : '',
      });
    }
    if (data.issn !== undefined && data.issn !== existing.issn) {
      identifierChanges.push({
        type: 'issn',
        value: (data.issn ?? '').trim(),
        canonicalUri: data.issn ? `urn:issn:${data.issn.trim()}` : '',
      });
    }
    for (const ident of identifierChanges) {
      // Always delete existing record(s) for this type first
      await client.catalogIdentifier.deleteMany({
        where: { catalogItemId: updated.id, type: ident.type },
      });
      // Re-create only if new value is non-empty
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

  async getRelations(
    itemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<any[]> {
    const client = this.getClient(tx);
    const relations = await client.itemRelation.findMany({
      where: { sourceItemId: itemId },
      include: { targetItem: true },
    });
    if (relations && relations.length > 0) {
      return relations.map((r) => ({
        id: r.id,
        targetItemId: r.targetItemId,
        relationType: r.relationType,
        description: r.description,
        targetItem: r.targetItem,
      }));
    }
    const item = await client.catalogItem.findUnique({
      where: { id: itemId },
      select: { extra: true },
    });
    if (!item || !item.extra) return [];
    try {
      const parsed = JSON.parse(item.extra);
      return Array.isArray(parsed.relations) ? parsed.relations : [];
    } catch {
      return [];
    }
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
      select: { workspaceId: true, extra: true },
    });
    if (!source) return;

    try {
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
    } catch {
      let extraObj: Record<string, any> = {};
      try {
        if (source.extra) extraObj = JSON.parse(source.extra);
      } catch (_err) {
        // ignore malformed JSON extra
      }
      const existing = Array.isArray(extraObj.relations)
        ? extraObj.relations
        : [];
      const filtered = existing.filter(
        (r: any) => (r.targetItemId || r.targetId) !== targetItemId,
      );
      filtered.push(relation);
      extraObj.relations = filtered;
      await client.catalogItem.update({
        where: { id: itemId },
        data: { extra: JSON.stringify(extraObj) },
      });
    }
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

  toDomainSummary(item: any): CatalogItemSummary {
    const authors: string[] = Array.isArray(item.contributors)
      ? item.contributors
          .map(
            (c: any) =>
              c.fullName || `${c.firstName || ''} ${c.lastName || ''}`.trim(),
          )
          .filter(Boolean)
      : [];

    const doiIdent = Array.isArray(item.identifiers)
      ? item.identifiers.find((i: any) => i.type === 'doi')?.value
      : null;

    return {
      id: item.id,
      workspaceId: item.workspaceId,
      title: item.title,
      itemType: item.itemType,
      year: item.year,
      doi: doiIdent || item.doi || null,
      primaryAuthors: authors,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }
}
