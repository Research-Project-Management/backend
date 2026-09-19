import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
  Inject,
  Optional,
} from '@nestjs/common';
import { Prisma, RagStatus } from '@prisma/client';
import { PrismaService } from '../../../../core/database/prisma.service';
import { VersionMismatchException } from '../../core/errors/version-mismatch.exception';
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
  sanitizeItemTitle,
} from '../utils/items.utils';
import {
  getFileContentPath,
  IStoragePort,
  STORAGE_PORT,
} from '@/modules/storage/storage.port';
import {
  parseAccessDate,
  ITEM_COLUMN_METADATA_FIELDS,
  FIELD_ALIASES,
} from '../constants/items.constants';
import { CreateItemData, UpdateItemData } from '../types/items.types';
import { isUUID } from 'class-validator';

const isUuid = (val: unknown): val is string =>
  typeof val === 'string' &&
  Boolean(val) &&
  (process.env.NODE_ENV === 'test' || isUUID(val));

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

/**
 * Unpacks the Extra field from DB.
 * Supports both JSON envelopes and legacy plain text.
 */
export function unpackExtraFromDb(rawExtra?: string | null): {
  cleanExtra: string;
  extraFields: Record<string, any>;
} {
  if (!rawExtra || typeof rawExtra !== 'string' || !rawExtra.trim()) {
    return { cleanExtra: '', extraFields: {} };
  }
  const trimmed = rawExtra.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const cleanExtra =
          typeof parsed._rawExtra === 'string' ? parsed._rawExtra : '';
        const fields = { ...parsed };
        delete fields._rawExtra;
        return { cleanExtra, extraFields: fields };
      }
    } catch {
      // fallback to plain text
    }
  }
  return { cleanExtra: trimmed, extraFields: {} };
}

/**
 * Packages non-column schema fields and user Extra text into DB extra storage.
 * When non-column schema fields exist, stores a clean JSON envelope.
 * Otherwise, stores user Extra as plain text.
 */
export function packExtraPayload(
  rawExtra: string | null | undefined,
  extraFields: Record<string, any> | null | undefined,
): string {
  let cleanExtra = '';
  if (typeof rawExtra === 'string' && rawExtra.trim()) {
    const trimmed = rawExtra.trim();
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed);
        cleanExtra =
          typeof parsed._rawExtra === 'string'
            ? parsed._rawExtra.trim()
            : trimmed;
      } catch {
        cleanExtra = trimmed;
      }
    } else {
      cleanExtra = trimmed;
    }
  }

  const fields = { ...(extraFields || {}) };
  delete fields._rawExtra;

  const INTERNAL_EXTRA_IGNORED_FIELDS = new Set([
    'comment',
    'comments',
    'notes',
    'provenance',
    'tags',
    'keywords',
    'creators',
    'authors',
    'repository',
    'archiveId',
    'primaryCategory',
    'openAccessPdfUrl',
    'confidenceScore',
    'originProvider',
  ]);

  const cleanedFields: Record<string, any> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (
      v !== undefined &&
      v !== null &&
      v !== '' &&
      !ITEM_COLUMN_METADATA_FIELDS.has(k) &&
      !INTERNAL_EXTRA_IGNORED_FIELDS.has(k)
    ) {
      cleanedFields[k] = v;
    }
  }

  if (Object.keys(cleanedFields).length > 0) {
    return JSON.stringify({
      ...cleanedFields,
      ...(cleanExtra ? { _rawExtra: cleanExtra } : {}),
    });
  }

  return cleanExtra;
}

/**
 * Resolves the Extra plain text field according to Zotero standard.
 * In Zotero, the Extra field contains user notes and translator variables (e.g. arXiv: ..., PMID: ...).
 * It is never an internal bucket for dumping unmapped schema or telemetry fields.
 */
export function resolveExtraPlainText(
  extraInput?: string | null,
  existingExtra?: string | null,
  patches?: Record<string, any> | null,
): string | undefined {
  let cleanRaw: string =
    (extraInput !== undefined && extraInput !== null
      ? extraInput
      : existingExtra) ?? '';

  // If rawExtra is stored as a JSON string with _rawExtra, extract it
  if (cleanRaw.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(cleanRaw.trim());
      if (typeof parsed._rawExtra === 'string') {
        cleanRaw = parsed._rawExtra;
      }
    } catch {
      // not json
    }
  }

  if (!patches || Object.keys(patches).length === 0) {
    return cleanRaw.trim() || undefined;
  }

  // Process line by line according to Zotero Extra field conventions
  const lines = cleanRaw.split('\n');
  const handledKeys = new Set<string>();
  const updatedLines: string[] = [];

  for (const line of lines) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) {
      if (line.trim()) updatedLines.push(line);
      continue;
    }
    const lineKey = line.slice(0, colonIndex).trim().toLowerCase();
    const linePrefix = line.slice(0, colonIndex).trim();

    // Check if any patch matches this lineKey (case-insensitive)
    let matchedPatchKey: string | undefined;
    for (const pKey of Object.keys(patches)) {
      if (pKey.toLowerCase() === lineKey) {
        matchedPatchKey = pKey;
        break;
      }
    }

    if (matchedPatchKey) {
      handledKeys.add(matchedPatchKey);
      const val = patches[matchedPatchKey];
      if (val !== null && val !== undefined && val !== '') {
        updatedLines.push(`${linePrefix}: ${val}`);
      }
      // If val is null, undefined, or empty string, line is deleted
    } else {
      updatedLines.push(line);
    }
  }

  // Append new patches that weren't in existing lines
  for (const [pKey, val] of Object.entries(patches)) {
    if (handledKeys.has(pKey)) continue;
    if (val !== null && val !== undefined && val !== '') {
      const formattedKey = pKey.charAt(0).toUpperCase() + pKey.slice(1);
      updatedLines.push(`${formattedKey}: ${val}`);
    }
  }

  const result = updatedLines.join('\n').trim();
  return result || undefined;
}

export function extractNonColumnExtraFields(
  data?: Record<string, any> | null,
  existingExtraFields?: Record<string, any> | null,
): Record<string, any> {
  const result: Record<string, any> = { ...(existingExtraFields || {}) };
  if (!data || typeof data !== 'object') return result;

  const ignoredSystemKeys = new Set([
    'id',
    'userId',
    'projectId',
    'workspaceId',
    'createdById',
    'uploadedById',
    'createdAt',
    'updatedAt',
    'deletedAt',
    'version',
    'expectedVersion',
    'creators',
    'authors',
    'contributors',
    'editors',
    'tags',
    'labels',
    'itemTags',
    'keywords',
    'attachments',
    'notes',
    'notesList',
    'collectionId',
    'collectionIds',
    'collections',
    'collectionItems',
    'userStates',
    'states',
    'extraFields',
    'fileId',
    'fileUrl',
    'size',
    'mimeType',
    'crossrefEnriched',
    'ragDocId',
    'ragIndexedAt',
    'ragLastAttemptAt',
    'ragAttempts',
    'ragError',
    'ragStatus',
    'isRetracted',
    'retractionNature',
    'retractionDetails',
    'retractionCheckedAt',
    'isMyPublication',
    'publicationConfirmedAt',
  ]);

  for (const [key, value] of Object.entries(data)) {
    if (ignoredSystemKeys.has(key)) continue;
    if (ITEM_COLUMN_METADATA_FIELDS.has(key) || FIELD_ALIASES[key]) continue;
    if (value !== undefined) {
      result[key] = value;
    }
  }

  if (data.extraFields && typeof data.extraFields === 'object') {
    for (const [k, v] of Object.entries(data.extraFields)) {
      if (
        v !== undefined &&
        !ignoredSystemKeys.has(k) &&
        !ITEM_COLUMN_METADATA_FIELDS.has(k) &&
        !FIELD_ALIASES[k]
      ) {
        result[k] = v;
      }
    }
  }

  return result;
}

export function prepareNotesToCreate(
  notes: unknown,
  userId: string,
  createdById: string,
  existingNotesList?: Array<{ contentMd: string }>,
) {
  if (!Array.isArray(notes)) return [];

  const seen = new Set(
    (existingNotesList || []).map((n) => n.contentMd.trim()),
  );

  return notes
    .map((note) => {
      const noteObj =
        typeof note === 'object' && note !== null
          ? (note as Record<string, unknown>)
          : null;
      const rawContent =
        typeof note === 'string'
          ? note
          : typeof noteObj?.content === 'string'
            ? noteObj.content
            : typeof noteObj?.contentMd === 'string'
              ? noteObj.contentMd
              : typeof noteObj?.note === 'string'
                ? noteObj.note
                : '';
      // Strip HTML if from Zotero child note (<p>...</p>)
      const cleanContent = /<\/?[a-z][\s\S]*>/i.test(rawContent)
        ? rawContent
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
        : rawContent.trim();
      const source =
        typeof noteObj?.source === 'string' ? noteObj.source.trim() : undefined;
      const contentMd = cleanContent;
      if (!contentMd || seen.has(contentMd)) return null;
      seen.add(contentMd);

      const sourceName = source || '';
      const isComment = contentMd.toLowerCase().startsWith('comment:');
      const noteTitle =
        typeof noteObj?.title === 'string' && noteObj.title.trim()
          ? noteObj.title.trim()
          : isComment
            ? sourceName
              ? `Comment (${sourceName})`
              : 'Comment'
            : sourceName
              ? `Imported Note (${sourceName})`
              : 'Imported Note';

      return {
        userId,
        createdById: createdById || userId || 'system',
        title: noteTitle,
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
        tags: [
          'imported',
          ...(sourceName ? [sourceName] : []),
          ...(isComment ? ['comment'] : []),
        ],
        version: 1,
      };
    })
    .filter((n): n is NonNullable<typeof n> => n !== null);
}

async function resolveOrCreateTags(
  client: Prisma.TransactionClient | PrismaService,
  userId: string,
  rawTagList: (TagInput | null | undefined)[],
): Promise<string[]> {
  const normalizedTagNames = normalizeTags(rawTagList).slice(0, 30);
  if (normalizedTagNames.length === 0) return [];

  await client.tag.createMany({
    data: normalizedTagNames.map((name) => ({
      userId,
      name,
    })),
    skipDuplicates: true,
  });

  const existingTags = await client.tag.findMany({
    where: {
      userId,
      name: { in: normalizedTagNames },
    },
    select: { id: true },
  });
  return existingTags.map((t) => t.id);
}

async function syncTagsForCatalogItem(
  client: Prisma.TransactionClient | PrismaService,
  userId: string,
  itemId: string,
  rawTags: (TagInput | null | undefined)[],
): Promise<void> {
  const normalizedTagsList = normalizeTags(rawTags);
  if (normalizedTagsList.length === 0) {
    await client.itemTag.deleteMany({
      where: { itemId },
    });
    return;
  }

  await client.itemTag.deleteMany({
    where: {
      itemId,
      tag: {
        name: { notIn: normalizedTagsList },
      },
    },
  });

  for (const tagName of normalizedTagsList) {
    const tag = await client.tag.upsert({
      where: {
        userId_name: {
          userId,
          name: tagName,
        },
      },
      create: {
        userId,
        name: tagName,
      },
      update: {},
    });
    await client.itemTag.upsert({
      where: {
        tagId_itemId: {
          tagId: tag.id,
          itemId,
        },
      },
      create: {
        tagId: tag.id,
        itemId,
      },
      update: {},
    });
  }
}

@Injectable()
export class CommandRepository {
  private readonly logger = new Logger(CommandRepository.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(STORAGE_PORT)
    private readonly storagePort?: IStoragePort,
  ) {}

  private getClient(tx?: Prisma.TransactionClient) {
    return tx ?? this.prisma;
  }

  async create(
    userId: string,
    data: CreateItemData,
    tx?: Prisma.TransactionClient,
    projectId?: string,
  ) {
    const client = this.getClient(tx);
    const rawFileId =
      data.fileId ||
      data.fileUrl?.match(/\/api\/files\/([a-zA-Z0-9-]+)\/content/)?.[1] ||
      null;
    const resolvedFileId = rawFileId && isUUID(rawFileId) ? rawFileId : null;

    const notes = prepareNotesToCreate(
      data.notes,
      userId,
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
      userId,
      rawTagList,
    );

    const resolvedPubTitle =
      data.publicationTitle ??
      data.journal ??
      (data as any).bookTitle ??
      (data as any).proceedingsTitle ??
      (data as any).websiteTitle ??
      (data as any).blogTitle ??
      (data as any).dictionaryTitle ??
      (data as any).encyclopediaTitle ??
      (data as any).forumTitle ??
      (data as any).sessionTitle ??
      (data as any).programTitle ??
      '';

    const resolvedPublisher =
      data.publisher ??
      (data as any).university ??
      (data as any).institution ??
      (data as any).repository ??
      (data as any).company ??
      (data as any).distributor ??
      (data as any).label ??
      (data as any).studio ??
      (data as any).network ??
      '';

    const effectiveExtraFields = extractNonColumnExtraFields(data as any, null);

    const createData: any = {
      userId,
      title: sanitizeItemTitle(data.title) || 'Untitled Item',
      year: data.year ?? null,
      doi: cleanDoi,
      abstract: data.abstract ?? data.abstractNote ?? '',
      itemType: data.itemType ?? 'journalArticle',
      publicationTitle: resolvedPubTitle,
      publicationDate:
        data.publicationDate ??
        data.date ??
        (data.year ? String(data.year) : ''),
      publisher: resolvedPublisher,
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
      extra:
        resolveExtraPlainText(data.extra, null, effectiveExtraFields) ?? '',
      uploadedById: data.uploadedById || 'system',
      projectId:
        (projectId && projectId !== 'user' && isUUID(projectId)
          ? projectId
          : undefined) ||
        (data.projectId && isUUID(data.projectId) ? data.projectId : null),
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
              create: data.contributors.map((c: any, index: number) => {
                const fullName =
                  c.fullName ||
                  [c.firstName, c.lastName].filter(Boolean).join(' ') ||
                  c.name ||
                  '';
                let first = c.firstName || '';
                let last = c.lastName || '';
                if (!first && !last && fullName) {
                  const parsed = parseCreatorString(fullName, index);
                  first = parsed.firstName;
                  last = parsed.lastName;
                }
                return {
                  creatorType: c.creatorType || 'author',
                  firstName: first,
                  lastName: last,
                  fullName,
                  orderIndex: c.orderIndex !== undefined ? c.orderIndex : index,
                };
              }),
            },
          }
        : data.creators && data.creators.length > 0
          ? {
              contributors: {
                create: data.creators.map((c: any, index: number) => {
                  const fullName =
                    c.fullName ||
                    [c.firstName, c.lastName].filter(Boolean).join(' ') ||
                    c.name ||
                    '';
                  let first = c.firstName || '';
                  let last = c.lastName || '';
                  if (!first && !last && fullName) {
                    const parsed = parseCreatorString(fullName, index);
                    first = parsed.firstName;
                    last = parsed.lastName;
                  }
                  return {
                    creatorType: c.creatorType || 'author',
                    firstName: first,
                    lastName: last,
                    fullName,
                    orderIndex:
                      c.orderIndex !== undefined ? c.orderIndex : index,
                  };
                }),
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

    const item = await client.item.create({
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
        notesList: {
          where: { deletedAt: null },
        },
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
    userId: string,
    id: string,
    expectedVersion: number | undefined,
    data: UpdateItemData,
    tx?: Prisma.TransactionClient,
    projectId?: string,
  ) {
    if (!isUuid(id) || !isUuid(userId)) {
      throw new NotFoundException(`CatalogItem ${id} not found`);
    }
    const client = this.getClient(tx);
    const existing = await client.item.findFirst({
      where: {
        id,
        deletedAt: null,
        ...(projectId && projectId !== 'user' && isUUID(projectId)
          ? { projectId }
          : { userId }),
      } as any,
      include: {
        identifiers: true,
        notesList: { where: { deletedAt: null } },
      },
    });

    if (!existing) {
      throw new NotFoundException(`CatalogItem ${id} not found`);
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
    const { cleanExtra: existingRawExtra, extraFields: existingParsedFields } =
      unpackExtraFromDb(existing.extra);
    const effectiveExtraFields = extractNonColumnExtraFields(
      data as any,
      existingParsedFields,
    );

    const rawPubDate =
      data.publicationDate !== undefined ? data.publicationDate : data.date;
    const rawPubTitle =
      data.publicationTitle !== undefined
        ? data.publicationTitle
        : data.journal !== undefined
          ? data.journal
          : (data as any).bookTitle !== undefined
            ? (data as any).bookTitle
            : (data as any).proceedingsTitle !== undefined
              ? (data as any).proceedingsTitle
              : (data as any).websiteTitle !== undefined
                ? (data as any).websiteTitle
                : (data as any).blogTitle !== undefined
                  ? (data as any).blogTitle
                  : (data as any).dictionaryTitle !== undefined
                    ? (data as any).dictionaryTitle
                    : (data as any).encyclopediaTitle !== undefined
                      ? (data as any).encyclopediaTitle
                      : (data as any).forumTitle !== undefined
                        ? (data as any).forumTitle
                        : (data as any).sessionTitle !== undefined
                          ? (data as any).sessionTitle
                          : (data as any).programTitle !== undefined
                            ? (data as any).programTitle
                            : undefined;

    const rawPublisher =
      data.publisher !== undefined
        ? data.publisher
        : (data as any).university !== undefined
          ? (data as any).university
          : (data as any).institution !== undefined
            ? (data as any).institution
            : (data as any).repository !== undefined
              ? (data as any).repository
              : (data as any).company !== undefined
                ? (data as any).company
                : (data as any).distributor !== undefined
                  ? (data as any).distributor
                  : (data as any).label !== undefined
                    ? (data as any).label
                    : (data as any).studio !== undefined
                      ? (data as any).studio
                      : (data as any).network !== undefined
                        ? (data as any).network
                        : undefined;
    const rawJournalAbbr =
      data.journalAbbr !== undefined
        ? data.journalAbbr
        : data.journalAbbreviation;
    const rawRights = data.rights !== undefined ? data.rights : data.license;
    const rawCitationKey =
      data.citationKey !== undefined ? data.citationKey : data.citeKey;

    const newNotesToCreate = prepareNotesToCreate(
      data.notes,
      userId,
      data.userId || existing.uploadedById || 'system',
      existing.notesList,
    );

    const parsedYearMatch =
      rawPubDate !== undefined
        ? String(rawPubDate).match(
            /(?:^|[^\d])(1[7-9]\d{2}|20\d{2})(?:[^\d]|$)/,
          )
        : null;
    const extractedYear = parsedYearMatch
      ? parseInt(parsedYearMatch[1], 10)
      : null;

    const updated = await client.item.update({
      where: { id },
      data: {
        title:
          data.title !== undefined
            ? sanitizeItemTitle(data.title) || existing.title
            : existing.title,
        year:
          data.year !== undefined
            ? data.year
            : extractedYear !== null
              ? extractedYear
              : existing.year,
        doi: cleanDoi !== undefined ? cleanDoi : existing.doi,
        abstract: cleanAbstract,
        itemType: data.itemType ?? existing.itemType,
        publicationTitle:
          rawPubTitle !== undefined ? rawPubTitle : existing.publicationTitle,

        publicationDate:
          rawPubDate !== undefined ? rawPubDate : existing.publicationDate,
        publisher:
          rawPublisher !== undefined ? rawPublisher : existing.publisher,
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
          resolveExtraPlainText(
            data.extra,
            existingRawExtra,
            effectiveExtraFields,
          ) ??
          existingRawExtra ??
          '',

        ...(data.collectionIds !== undefined
          ? {
              collectionItems: (() => {
                const raw = Array.isArray(data.collectionIds)
                  ? data.collectionIds
                  : [];
                const unique = Array.from(
                  new Set(
                    raw.filter(
                      (cid: string): cid is string =>
                        typeof cid === 'string' && cid.trim().length > 0,
                    ),
                  ),
                );
                return unique.length > 0
                  ? {
                      deleteMany: {},
                      create: unique.map((cid, idx) => ({
                        collection: { connect: { id: cid } },
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
                          collection: {
                            connect: { id: data.collectionId.trim() },
                          },
                          sortOrder: 0,
                        },
                      }
                    : {
                        deleteMany: {},
                      },
              }
            : {}),
        ...(data.contributors !== undefined || data.creators !== undefined
          ? {
              contributors: {
                deleteMany: {},
                create: (data.contributors || data.creators || []).map(
                  (c: any, index: number) => {
                    const fullName =
                      c.fullName ||
                      [c.firstName, c.lastName].filter(Boolean).join(' ') ||
                      c.name ||
                      '';
                    let first = c.firstName || '';
                    let last = c.lastName || '';
                    if (!first && !last && fullName) {
                      const parsed = parseCreatorString(fullName, index);
                      first = parsed.firstName;
                      last = parsed.lastName;
                    }
                    return {
                      creatorType: c.creatorType || 'author',
                      firstName: first,
                      lastName: last,
                      fullName,
                      orderIndex:
                        c.orderIndex !== undefined ? c.orderIndex : index,
                    };
                  },
                ),
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
      (identifierItem: any) => identifierItem.type === 'arxiv',
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
      await client.identifier.deleteMany({
        where: { itemId: updated.id, type: ident.type },
      });
      if (ident.value) {
        await client.identifier.create({
          data: {
            itemId: updated.id,
            type: ident.type,
            value: ident.value,
            canonicalUri: ident.canonicalUri || undefined,
          },
        });
      }
    }

    const rawTags = data.tags || data.keywords || data.labels;
    if (rawTags && Array.isArray(rawTags)) {
      await syncTagsForCatalogItem(client, userId, updated.id, rawTags);

      const reloaded = await client.item.findUnique({
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
          attachments: {
            include: { revisions: true },
          },
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
    userId: string,
    id: string,
    expectedVersion?: number,
    tx?: Prisma.TransactionClient,
    projectId?: string,
  ): Promise<boolean> {
    if (!isUuid(id) || !isUuid(userId)) {
      return false;
    }
    const client = this.getClient(tx);
    const whereCondition: any = {
      id,
      deletedAt: null,
      ...(projectId && projectId !== 'user' ? { projectId } : { userId }),
    };
    if (expectedVersion !== undefined) {
      const existing = await client.item.findFirst({
        where: whereCondition,
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

    const result = await client.item.updateMany({
      where: whereCondition,
      data: { deletedAt: new Date() },
    });

    return result.count > 0;
  }

  async restore(
    userId: string,
    id: string,
    expectedVersion?: number,
    tx?: Prisma.TransactionClient,
    projectId?: string,
  ) {
    if (!isUuid(id) || !isUuid(userId)) {
      throw new NotFoundException(`Trashed item ${id} not found`);
    }
    const client = this.getClient(tx);
    const existing = await client.item.findFirst({
      where: {
        id,
        deletedAt: { not: null },
        ...(projectId && projectId !== 'user' ? { projectId } : { userId }),
      },
    });

    if (!existing) {
      throw new NotFoundException(`Trashed item ${id} not found`);
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

    return client.item.update({
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
    userId: string,
    id: string,
    tx?: Prisma.TransactionClient,
    projectId?: string,
  ): Promise<boolean> {
    if (!isUuid(id) || !isUuid(userId)) {
      throw new NotFoundException(`Item ${id} not found`);
    }
    const client = this.getClient(tx);
    const existing = await client.item.findFirst({
      where: {
        id,
        ...(projectId && projectId !== 'user' ? { projectId } : { userId }),
      },
    });

    if (!existing) {
      throw new NotFoundException(`Item ${id} not found`);
    }

    if (!existing.deletedAt) {
      throw new BadRequestException(
        `Item ${id} must be in trash before it can be permanently purged`,
      );
    }

    const attachments = await client.attachment.findMany({
      where: { itemId: id },
      select: { id: true, fileId: true, url: true },
    });

    for (const att of attachments) {
      const fileId =
        att.fileId ||
        att.url?.match(
          /\/api\/(?:v1\/(?:projects\/[^/]+\/)?library\/)?(?:attachments\/)?files\/([a-zA-Z0-9_-]+)/,
        )?.[1];
      if (fileId && this.storagePort?.deleteFile) {
        try {
          await this.storagePort.deleteFile(fileId);
        } catch (err: any) {
          this.logger.warn(
            `Failed to delete storage file ${fileId} during item purge: ${err?.message}`,
          );
        }
      }
    }

    await client.item.delete({
      where: { id },
    });

    return true;
  }

  async putRelation(
    itemId: string,
    relation: any,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const targetItemId = relation.targetItemId || relation.targetId;
    if (!targetItemId || !isUuid(itemId) || !isUuid(targetItemId)) return;
    const client = this.getClient(tx);

    const source = await client.item.findUnique({
      where: { id: itemId },
      select: { userId: true },
    });
    if (!source) return;

    const rawType = String(relation.relationType || '')
      .trim()
      .toLowerCase();
    const validRelationTypes = new Set([
      'cites',
      'cited_by',
      'replicates',
      'extends',
      'is_preprint_of',
      'is_published_version_of',
      'is_translation_of',
      'supplements',
      'related',
      'rebuts',
      'uses_dataset',
      'survey_of',
    ]);
    const relationType = validRelationTypes.has(rawType)
      ? (rawType as any)
      : 'related';

    await client.itemRelation.upsert({
      where: {
        sourceItemId_targetItemId_relationType: {
          sourceItemId: itemId,
          targetItemId,
          relationType,
        },
      },
      create: {
        sourceItemId: itemId,
        targetItemId,
        relationType,
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
    if (!isUuid(itemId) || !isUuid(targetItemId)) return;
    const client = this.getClient(tx);
    await client.itemRelation.deleteMany({
      where: {
        OR: [
          { sourceItemId: itemId, targetItemId },
          { sourceItemId: targetItemId, targetItemId: itemId },
        ],
      },
    });

    const item = await client.item.findUnique({
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
          await client.item.update({
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

  async setMyPublication(
    userId: string,
    id: string,
    isMyPublication: boolean,
    tx?: Prisma.TransactionClient,
  ) {
    if (!isUuid(id) || !isUuid(userId)) {
      throw new NotFoundException(`CatalogItem ${id} not found`);
    }
    const client = this.getClient(tx);
    const existing = await client.item.findFirst({
      where: { id, userId, deletedAt: null },
    });

    if (!existing) {
      throw new NotFoundException(`CatalogItem ${id} not found`);
    }

    return client.item.update({
      where: { id },
      data: {
        isMyPublication,
        publicationConfirmedAt: isMyPublication ? new Date() : null,
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
        attachments: true,
      },
    });
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
    if (!isUuid(id)) return null as any;
    const client = this.getClient(tx);
    return client.item.update({
      where: { id },
      data,
    });
  }
}

export { CommandRepository as ItemCommandRepository };
