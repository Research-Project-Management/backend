import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { Prisma, RagStatus } from '@prisma/client';
import { PrismaService } from '../../../../core/database/prisma.service';
import { VersionMismatchException } from '../../common/errors/version-mismatch.exception';
import { normalizeTags } from '../../tags/utils/tags.utils';
import { TagInput } from '../../tags/types/tags.types';
import {
  parseCreatorString,
  normalizeDoi,
  normalizeArxivId,
  normalizePmid,
  normalizePmcid,
  normalizeIsbn,
  normalizeIssn,
  cleanBannedString,
  cleanAbstractText,
} from '../utils/items.utils';
import { getFileContentPath } from '@/modules/storage/storage.port';
import {
  CATALOG_COLUMN_METADATA_FIELDS,
  TYPE_SPECIFIC_EXTRA_FIELDS,
  parseAccessDate,
} from '../constants/items.constants';
import {
  CreateCatalogItemData,
  UpdateCatalogItemData,
} from '../types/items.types';

function formatExtraMetadataEntries(parsed: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(parsed)) {
    if (
      v !== null &&
      v !== undefined &&
      v !== '' &&
      !CATALOG_COLUMN_METADATA_FIELDS.has(k)
    ) {
      let formatted: string;
      if (typeof v === 'string') {
        formatted = v;
      } else if (typeof v === 'number' || typeof v === 'boolean') {
        formatted = String(v);
      } else {
        formatted = JSON.stringify(v);
      }
      lines.push(`${k}: ${formatted}`);
    }
  }
  return lines.join('\n');
}

function cleanSingleIdentifier(
  raw: string | null | undefined,
  normalizer: (val?: any) => string | undefined,
): string | undefined {
  if (raw === undefined) return undefined;
  if (!raw) return '';
  const cleaned = cleanBannedString(raw);
  return normalizer(cleaned) || cleaned || '';
}

export function normalizeItemIdentifiers(data: {
  doi?: string | null;
  DOI?: string | null;
  arxivId?: string | null;
  archiveID?: string | null;
  archiveId?: string | null;
  pmid?: string | null;
  PMID?: string | null;
  pmcid?: string | null;
  PMCID?: string | null;
  isbn?: string | null;
  ISBN?: string | null;
  issn?: string | null;
  ISSN?: string | null;
}) {
  const rawDoi = data.doi !== undefined ? data.doi : data.DOI;
  const rawArxivId =
    data.arxivId !== undefined
      ? data.arxivId
      : data.archiveID !== undefined
        ? data.archiveID
        : data.archiveId;
  const rawPmid = data.pmid !== undefined ? data.pmid : data.PMID;
  const rawPmcid = data.pmcid !== undefined ? data.pmcid : data.PMCID;
  const rawIsbn = data.isbn !== undefined ? data.isbn : data.ISBN;
  const rawIssn = data.issn !== undefined ? data.issn : data.ISSN;

  return {
    doi: cleanSingleIdentifier(rawDoi, normalizeDoi),
    arxivId: cleanSingleIdentifier(rawArxivId, normalizeArxivId),
    pmid: cleanSingleIdentifier(rawPmid, normalizePmid),
    pmcid: cleanSingleIdentifier(rawPmcid, normalizePmcid),
    isbn: cleanSingleIdentifier(rawIsbn, normalizeIsbn),
    issn: cleanSingleIdentifier(rawIssn, normalizeIssn),
  };
}

export function resolveExtraPlainText(
  extraInput?: string | null,
  existingExtra?: string | null,
): string | undefined {
  const parseCandidate = (raw: string): string => {
    const trimmed = raw.trim();
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed._rawExtra === 'string') {
          return parsed._rawExtra.trim();
        }
        if (parsed && typeof parsed === 'object') {
          return formatExtraMetadataEntries(parsed as Record<string, unknown>);
        }
      } catch {
        return trimmed;
      }
    }
    return trimmed;
  };

  if (extraInput !== undefined) {
    if (typeof extraInput === 'string' && extraInput.trim()) {
      return parseCandidate(extraInput);
    }
    return '';
  }

  if (existingExtra !== undefined && existingExtra !== null) {
    return parseCandidate(existingExtra);
  }

  return undefined;
}

export function prepareNotesToCreate(
  notes: unknown,
  workspaceId: string,
  userId: string,
  existingNotesList?: Array<{ contentMd: string }>,
) {
  if (!Array.isArray(notes)) return [];

  const seen = new Set(
    (existingNotesList || []).map((n) => n.contentMd.trim()),
  );

  return notes
    .map((note) => {
      const content =
        typeof note === 'string'
          ? note
          : (note as { content?: unknown })?.content;
      const source =
        typeof note === 'object' && note
          ? (note as { source?: unknown }).source
          : undefined;
      const contentMd = typeof content === 'string' ? content.trim() : '';
      if (!contentMd || seen.has(contentMd)) return null;
      seen.add(contentMd);

      const sourceName = typeof source === 'string' ? source.trim() : '';
      return {
        workspaceId,
        createdById: userId || 'system',
        title: sourceName ? `Imported Note (${sourceName})` : 'Imported Note',
        contentMd,
        contentJson: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: contentMd }],
            },
          ],
        },
        tags: ['imported', ...(sourceName ? [sourceName] : [])],
        version: 1,
      };
    })
    .filter((n): n is NonNullable<typeof n> => n !== null);
}

async function resolveOrCreateTags(
  client: Prisma.TransactionClient | PrismaService,
  workspaceId: string,
  rawTagList: (TagInput | null | undefined)[],
): Promise<string[]> {
  const normalizedTagNames = normalizeTags(rawTagList).slice(0, 30);
  if (normalizedTagNames.length === 0) return [];

  await client.catalogTag.createMany({
    data: normalizedTagNames.map((name) => ({
      workspaceId,
      name,
    })),
    skipDuplicates: true,
  });

  const existingTags = await client.catalogTag.findMany({
    where: {
      workspaceId,
      name: { in: normalizedTagNames },
    },
    select: { id: true },
  });
  return existingTags.map((t) => t.id);
}

async function syncTagsForCatalogItem(
  client: Prisma.TransactionClient | PrismaService,
  workspaceId: string,
  catalogItemId: string,
  rawTags: (TagInput | null | undefined)[],
): Promise<void> {
  const normalizedTagsList = normalizeTags(rawTags);
  if (normalizedTagsList.length === 0) {
    await client.catalogItemTag.deleteMany({
      where: { catalogItemId },
    });
    return;
  }

  await client.catalogItemTag.deleteMany({
    where: {
      catalogItemId,
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
          catalogItemId,
        },
      },
      create: {
        tagId: tag.id,
        catalogItemId,
      },
      update: {},
    });
  }
}

@Injectable()
export class CommandRepository {
  private readonly logger = new Logger(CommandRepository.name);

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

    const notes = prepareNotesToCreate(
      data.notes,
      workspaceId,
      data.uploadedById || 'system',
    );

    const ids = normalizeItemIdentifiers(data);
    const cleanDoi = ids.doi ?? '';
    const cleanArxivId = ids.arxivId ?? '';
    const cleanPmid = ids.pmid ?? '';
    const cleanPmcid = ids.pmcid ?? '';
    const cleanIsbn = ids.isbn ?? '';
    const cleanIssn = ids.issn ?? '';

    // Concurrency-safe tag preparation
    const rawTagList = [
      ...(data.tags || []),
      ...(data.keywords || []),
      ...(data.labels || []),
    ];
    const resolvedTagIds = await resolveOrCreateTags(
      client,
      workspaceId,
      rawTagList,
    );

    const createData: Prisma.CatalogItemUncheckedCreateInput = {
      workspaceId,
      title: data.title,
      year: data.year ?? null,
      doi: cleanDoi,
      abstract: data.abstract ?? data.abstractNote ?? '',
      itemType: data.itemType ?? 'journalArticle',
      publicationTitle: data.publicationTitle ?? data.journal ?? '',
      publicationDate:
        data.publicationDate ??
        data.date ??
        (data.year ? String(data.year) : ''),
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
      journalAbbr: data.journalAbbr ?? data.journalAbbreviation ?? '',
      shortTitle: data.shortTitle ?? '',
      rights: data.rights ?? data.license ?? '',
      license: data.license ?? data.rights ?? '',
      citationKey: data.citationKey ?? data.citeKey ?? '',
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
      extra: resolveExtraPlainText(data.extra) ?? '',
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
      ...(data.contributors && data.contributors.length > 0
        ? {
            contributors: {
              create: data.contributors.map((c: any, index: number) => ({
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
      ...(resolvedTagIds.length > 0
        ? {
            itemTags: {
              create: resolvedTagIds.map((tagId) => ({
                tagId,
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
        notesList: { where: { deletedAt: null } },
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

    const ids = normalizeItemIdentifiers(data);
    const cleanDoi = ids.doi;
    const cleanArxivId = ids.arxivId;
    const cleanPmid = ids.pmid;
    const cleanPmcid = ids.pmcid;
    const cleanIsbn = ids.isbn;
    const cleanIssn = ids.issn;

    const rawAbstract =
      data.abstract !== undefined ? data.abstract : data.abstractNote;
    const cleanAbstract =
      rawAbstract !== undefined
        ? (cleanAbstractText(rawAbstract) ?? rawAbstract)
        : existing.abstract;
    const rawPubDate =
      data.publicationDate !== undefined ? data.publicationDate : data.date;
    const rawPubTitle =
      data.publicationTitle !== undefined
        ? data.publicationTitle
        : data.journal;
    const rawJournalAbbr =
      data.journalAbbr !== undefined
        ? data.journalAbbr
        : data.journalAbbreviation;
    const rawRights = data.rights !== undefined ? data.rights : data.license;
    const rawCitationKey =
      data.citationKey !== undefined ? data.citationKey : data.citeKey;

    const newNotesToCreate = prepareNotesToCreate(
      data.notes,
      workspaceId,
      data.userId || existing.uploadedById || 'system',
      existing.notesList,
    );

    const updated = await client.catalogItem.update({
      where: { id },
      data: {
        title: data.title ?? existing.title,
        year: data.year !== undefined ? data.year : existing.year,
        doi: cleanDoi !== undefined ? cleanDoi : existing.doi,
        abstract: cleanAbstract,
        itemType: data.itemType ?? existing.itemType,
        publicationTitle:
          rawPubTitle !== undefined ? rawPubTitle : existing.publicationTitle,

        publicationDate:
          rawPubDate !== undefined ? rawPubDate : existing.publicationDate,
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
        journalAbbr:
          rawJournalAbbr !== undefined ? rawJournalAbbr : existing.journalAbbr,
        shortTitle: data.shortTitle ?? existing.shortTitle,
        rights: rawRights !== undefined ? rawRights : existing.rights,
        license:
          rawRights !== undefined
            ? rawRights
            : data.license !== undefined
              ? data.license
              : existing.license,
        citationKey:
          rawCitationKey !== undefined ? rawCitationKey : existing.citationKey,
        libraryCatalog: data.libraryCatalog ?? existing.libraryCatalog,
        archive: data.archive ?? existing.archive,
        archiveLocation: data.archiveLocation ?? existing.archiveLocation,
        callNumber: data.callNumber ?? existing.callNumber,
        accessedAt:
          data.accessedAt !== undefined
            ? data.accessedAt
            : data.accessDate !== undefined
              ? (parseAccessDate(data.accessDate) ?? null)
              : existing.accessedAt,
        arxivId: cleanArxivId !== undefined ? cleanArxivId : existing.arxivId,
        citationCount:
          data.citationCount !== undefined
            ? data.citationCount
            : existing.citationCount,
        referenceCount:
          data.referenceCount !== undefined
            ? data.referenceCount
            : existing.referenceCount,
        openAccessPdfUrl:
          data.openAccessPdfUrl !== undefined
            ? data.openAccessPdfUrl
            : existing.openAccessPdfUrl,
        seriesNumber:
          data.seriesNumber !== undefined
            ? data.seriesNumber
            : existing.seriesNumber,
        extra:
          resolveExtraPlainText(data.extra, existing.extra) ??
          (existing.extra ?? ''),

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
        ...(newNotesToCreate.length > 0
          ? {
              notesList: {
                create: newNotesToCreate,
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
      await syncTagsForCatalogItem(client, workspaceId, updated.id, rawTags);

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
      } catch (err: unknown) {
        this.logger.warn(
          `Failed to parse or sanitize extra JSON for item ${itemId}: ${(err as Error)?.message}`,
        );
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

export { CommandRepository as ItemCommandRepository };
