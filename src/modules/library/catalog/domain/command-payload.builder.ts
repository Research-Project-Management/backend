import { Prisma, LinkMode, AttachmentType, TagType } from '@prisma/client';
import { PrismaService } from '@/core';
import {
  normalizeTags,
  cleanSingleTag,
} from '@/modules/library/core/domain/tag.domain';
import { buildTipTapDocFromText } from '@/modules/library/core/domain/tiptap.domain';
export { buildTipTapDocFromText };
import { TagInput } from '@/modules/library/catalog/types/tags.types';
import {
  normalizeDoi,
  normalizeArxivId,
  normalizePmid,
  normalizePmcid,
  normalizeIsbn,
  normalizeIssn,
  cleanBannedString,
  cleanAbstractText,
  sanitizeItemTitle,
  parseCreatorString,
  splitAuthorString,
  isNoiseAuthorName,
  convertAcademicHtmlToMarkdown,
} from '@/modules/library/core';
import {
  ITEM_COLUMN_METADATA_FIELDS,
  FIELD_ALIASES,
  BASE_FIELD_MAPPINGS,
  parseAccessDate,
} from '@/modules/library/catalog/types/items.constants';
import {
  getEffectiveBaseFieldMap,
  harmonizeZoteroFields,
  resolveCanonicalCreatorRole,
} from '@/modules/library/core/domain/zotero-field-harmonizer.domain';
import { getFileContentPath } from '@/modules/storage/storage.port';
import {
  CreateItemData,
  UpdateItemData,
  CreatorCreditInput,
  ItemDetail,
} from '@/modules/library/catalog/types/items.types';
import { isUUID } from 'class-validator';

export const isUuid = (val: unknown): val is string =>
  typeof val === 'string' &&
  Boolean(val) &&
  (process.env.NODE_ENV === 'test' || isUUID(val));

export function cleanSingleIdentifier(
  raw: string | null | undefined,
  normalizer: (val?: string | null) => string | undefined,
): string | undefined {
  if (raw === undefined) return undefined;
  if (!raw) return '';
  const cleaned = cleanBannedString(raw);
  return normalizer(cleaned) || cleaned || '';
}

export function extractExtraKeyValues(
  extraStr?: string | null,
): Record<string, string> {
  const result: Record<string, string> = {};
  if (!extraStr || typeof extraStr !== 'string') return result;

  for (const match of extraStr.matchAll(
    /\{:\s*([a-zA-Z_][a-zA-Z0-9_.\s-]*?)\s*:\s*([^}]+?)\s*\}/g,
  )) {
    const key = match[1]
      .trim()
      .toLowerCase()
      .replace(/[\s_]+/g, '-');
    result[key] = match[2].trim();
  }
  for (const line of extraStr.split(/\r?\n/)) {
    const m = line.trim().match(/^([a-zA-Z_][a-zA-Z0-9_.\s-]{0,40}):\s*(.+)$/);
    if (m) {
      const key = m[1]
        .trim()
        .toLowerCase()
        .replace(/[\s_]+/g, '-');
      if (!result[key]) {
        result[key] = m[2].trim();
      }
    }
  }
  return result;
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
  extra?: string | null;
  extraFields?: Record<string, unknown> | null;
}) {
  const rec = data as Record<string, unknown>;
  const ef =
    data.extraFields && typeof data.extraFields === 'object'
      ? data.extraFields
      : {};
  const extraKv = extractExtraKeyValues(data.extra);

  const pickFirst = (
    keys: string[],
    extraKvKeys: string[],
  ): string | null | undefined => {
    for (const k of keys) {
      const v = rec[k] !== undefined ? rec[k] : ef[k];
      if (v === null) return null;
      if (typeof v === 'string') return v;
      if (typeof v === 'number') return String(v);
    }
    for (const ek of extraKvKeys) {
      if (extraKv[ek] !== undefined) return extraKv[ek];
    }
    return undefined;
  };

  return {
    doi: cleanSingleIdentifier(
      pickFirst(['doi', 'DOI'], ['doi']),
      normalizeDoi,
    ),
    arxivId: cleanSingleIdentifier(
      pickFirst(['arxivId', 'archiveID', 'archiveId'], ['arxiv', 'arxivid']),
      normalizeArxivId,
    ),
    pmid: cleanSingleIdentifier(
      pickFirst(['pmid', 'PMID'], ['pmid']),
      normalizePmid,
    ),
    pmcid: cleanSingleIdentifier(
      pickFirst(['pmcid', 'PMCID'], ['pmcid', 'pmc']),
      normalizePmcid,
    ),
    isbn: cleanSingleIdentifier(
      pickFirst(['isbn', 'ISBN'], ['isbn']),
      normalizeIsbn,
    ),
    issn: cleanSingleIdentifier(
      pickFirst(['issn', 'ISSN'], ['issn']),
      normalizeIssn,
    ),
  };
}

export function unpackExtraFromDb(rawExtra?: string | null): {
  cleanExtra: string;
  extraFields: Record<string, unknown>;
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

export function packExtraPayload(
  rawExtra: string | null | undefined,
  _extraFields?: Record<string, unknown> | null,
): string {
  const { cleanExtra } = unpackExtraFromDb(rawExtra);
  return cleanExtra;
}

export function resolveExtraPlainText(
  extraInput?: string | null,
  existingExtra?: string | null,
  patches?: Record<string, unknown> | null,
): string | undefined {
  const rawCandidate =
    (extraInput !== undefined && extraInput !== null
      ? extraInput
      : existingExtra) ?? '';
  const { cleanExtra: cleanRaw } = unpackExtraFromDb(rawCandidate);

  if (!patches || Object.keys(patches).length === 0) {
    return cleanRaw.trim() || undefined;
  }

  const patchLookup = new Map<string, unknown>();
  for (const [pKey, pVal] of Object.entries(patches)) {
    if (!pKey.startsWith('__')) {
      patchLookup.set(pKey.toLowerCase(), pVal);
    }
  }

  const updatedLines: string[] = [];
  for (const line of cleanRaw.split('\n')) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) {
      if (line.trim()) updatedLines.push(line);
      continue;
    }
    const linePrefix = line.slice(0, colonIndex).trim();
    const lineKey = linePrefix.toLowerCase();
    if (patchLookup.has(lineKey)) {
      const val = patchLookup.get(lineKey);
      if (
        val !== null &&
        val !== undefined &&
        val !== '' &&
        typeof val !== 'object'
      ) {
        updatedLines.push(`${linePrefix}: ${val}`);
      }
    } else {
      updatedLines.push(line);
    }
  }

  return updatedLines.join('\n').trim() || undefined;
}

const IGNORED_SYSTEM_KEYS = new Set([
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
  '_version',
  'expectedVersion',
  'isDeleted',
  'silent',
  'creators',
  'authors',
  'contributors',
  'editors',
  'tags',
  'labels',
  'itemTags',
  'zoteroTags',
  'keywords',
  'keywordsList',
  'attachments',
  'primaryFile',
  'filename',
  'notes',
  'notesList',
  'collectionId',
  'collectionIds',
  'collections',
  'collectionItems',
  'userStates',
  'states',
  'readStatus',
  'rating',
  'lastReadAt',
  'extraFields',
  'fileId',
  'fileUrl',
  'size',
  'mimeType',
  'hasFile',
  'attachmentCount',
  'noteCount',
  'firstAuthor',
  'outgoingRel',
  'incomingRel',
  'relations',
  'seeAlso',
  'identifiers',
  'ingestionRuns',
  'itemMetadata',
  'publications',
  'crossrefEnriched',
  'ragDocId',
  'ragIndexedAt',
  'ragLastAttemptAt',
  'ragAttempts',
  'ragError',
  'ragStatus',
  'isRetracted',
  'retraction',
  'retractionStatus',
  'retractionDate',
  'retractionNature',
  'retractionReasons',
  'retractionNoticeDoi',
  'retractionDetails',
  'retractionCheckedAt',
  'isMyPublication',
  'publicationConfirmedAt',
  'ingestionStatus',
  'extractionStatus',
  'verificationScore',
  'isVerified',
  'matchedSignals',
  'missingFields',
  'isSelfSufficient',
  'qualityScore',
  'engineUsed',
  'provenance',
  'fieldProvenance',
  'sourceProvider',
  'source',
  'sources',
  'confidenceScore',
  'originProvider',
  'canonicalId',
  'canonicalUrl',
  'resolvedAt',
  'warnings',
  'disambiguationWarning',
  'rejectedCitedDoi',
  'wafKind',
  'promptUploadPdf',
  'dismissedDuplicateIds',
  'mergedCitationKeys',
  'mergedFromIds',
]);

export function extractNonColumnExtraFields(
  data?: Record<string, unknown> | null,
  existingExtraFields?: Record<string, unknown> | null,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...(existingExtraFields || {}) };
  if (!data || typeof data !== 'object') return result;

  const copyNonColumn = (source: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(source)) {
      if (
        value !== undefined &&
        !IGNORED_SYSTEM_KEYS.has(key) &&
        !ITEM_COLUMN_METADATA_FIELDS.has(key) &&
        !FIELD_ALIASES[key]
      ) {
        result[key] = value;
      }
    }
  };

  copyNonColumn(data);
  if (data.extraFields && typeof data.extraFields === 'object') {
    copyNonColumn(data.extraFields as Record<string, unknown>);
  }
  return result;
}

export function convertHtmlToMarkdown(html: string): string {
  return convertAcademicHtmlToMarkdown(html);
}

export function prepareNotesToCreate(
  notes: unknown,
  userId: string,
  createdById: string,
  existingNotesList?: unknown,
) {
  if (!Array.isArray(notes)) return [];

  const existingNotesArr = (
    Array.isArray(existingNotesList) ? existingNotesList : []
  ) as Array<{ contentMd?: string }>;
  const seen = new Set(
    existingNotesArr
      .map((n) => (typeof n.contentMd === 'string' ? n.contentMd.trim() : ''))
      .filter(Boolean),
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
          : (noteObj?.content ?? noteObj?.contentMd ?? noteObj?.note ?? '');
      const rawStr = typeof rawContent === 'string' ? rawContent : '';
      const contentMd = /<\/?[a-z][\s\S]*>/i.test(rawStr)
        ? convertHtmlToMarkdown(rawStr)
        : rawStr.trim();
      if (!contentMd || seen.has(contentMd)) return null;
      seen.add(contentMd);

      const sourceName =
        typeof noteObj?.source === 'string' ? noteObj.source.trim() : '';
      const isComment = contentMd.toLowerCase().startsWith('comment:');

      let noteTitle =
        typeof noteObj?.title === 'string' ? noteObj.title.trim() : '';
      if (!noteTitle) {
        const firstLine =
          contentMd
            .split(/\r?\n/)
            .find((l) => l.trim().length > 0)
            ?.replace(/^#+\s*/, '')
            .replace(/^>\s*/, '')
            .trim() || '';
        if (firstLine) {
          noteTitle =
            firstLine.length <= 80 ? firstLine : `${firstLine.slice(0, 77)}...`;
        } else {
          const baseLabel = isComment ? 'Comment' : 'Imported Note';
          noteTitle = sourceName ? `${baseLabel} (${sourceName})` : baseLabel;
        }
      }

      const contentJson =
        noteObj?.contentJson &&
        typeof noteObj.contentJson === 'object' &&
        'type' in (noteObj.contentJson as Record<string, unknown>)
          ? (noteObj.contentJson as Record<string, unknown>)
          : buildTipTapDocFromText(contentMd);

      const customTags = Array.isArray(noteObj?.tags)
        ? (noteObj.tags as unknown[]).filter(
            (t): t is string => typeof t === 'string' && t.trim().length > 0,
          )
        : [];

      const baseTags = normalizeTags([
        'imported',
        ...(sourceName ? [sourceName] : []),
        ...(isComment ? ['comment'] : []),
      ]);
      const mergedTags = Array.from(
        new Set([...baseTags, ...customTags.map((t) => t.trim())]),
      );

      return {
        userId,
        createdById: createdById || userId,
        title: noteTitle,
        contentMd,
        contentJson: contentJson as Prisma.InputJsonValue,
        tags: mergedTags,
        version: 1,
      };
    })
    .filter((n): n is NonNullable<typeof n> => n !== null);
}

export function prepareAttachmentsToCreate(
  attachments: unknown,
  fallbackFileId?: string | null,
  fallbackData?: {
    filename?: string;
    fileUrl?: string;
    size?: number;
    mimeType?: string;
  },
): Prisma.AttachmentCreateWithoutItemInput[] {
  const result: Prisma.AttachmentCreateWithoutItemInput[] = [];

  if (Array.isArray(attachments) && attachments.length > 0) {
    let hasPrimaryPdf = false;

    for (const rawAtt of attachments) {
      if (!rawAtt || typeof rawAtt !== 'object') continue;
      const att = rawAtt as Record<string, unknown>;
      const rawFileId = att.fileId || null;
      const resolvedFileId = rawFileId && isUuid(rawFileId) ? rawFileId : null;

      const title =
        (typeof att.title === 'string' && att.title.trim()) ||
        (typeof att.name === 'string' && att.name.trim()) ||
        '';
      const rawFilename =
        typeof att.filename === 'string' && att.filename.trim()
          ? att.filename.trim()
          : '';
      const filename =
        rawFilename ||
        (title
          ? title.toLowerCase().endsWith('.pdf')
            ? title
            : `${title}.pdf`
          : 'document.pdf');

      const mimeType =
        (typeof att.mimeType === 'string' && att.mimeType.trim()) ||
        (typeof att.contentType === 'string' && att.contentType.trim()) ||
        'application/pdf';
      const size = typeof att.size === 'number' ? att.size : 0;
      const fileUrl =
        typeof att.url === 'string' && att.url.trim()
          ? att.url.trim()
          : resolvedFileId
            ? getFileContentPath(resolvedFileId)
            : '';

      const isPdf =
        mimeType === 'application/pdf' ||
        filename.toLowerCase().endsWith('.pdf');
      let attachmentType: AttachmentType | undefined =
        (att.attachmentType as AttachmentType) ||
        (att.type as AttachmentType | undefined);
      if (!attachmentType) {
        if (!hasPrimaryPdf && isPdf) {
          attachmentType = AttachmentType.primary_pdf;
          hasPrimaryPdf = true;
        } else if (
          mimeType.includes('html') ||
          filename.toLowerCase().endsWith('.html')
        ) {
          attachmentType = AttachmentType.snapshot;
        } else {
          attachmentType = AttachmentType.supplementary;
        }
      } else if (attachmentType === AttachmentType.primary_pdf) {
        hasPrimaryPdf = true;
      }

      const linkMode: LinkMode =
        (att.linkMode as LinkMode | undefined) ||
        (resolvedFileId
          ? LinkMode.imported_file
          : fileUrl.startsWith('http')
            ? attachmentType === AttachmentType.snapshot
              ? LinkMode.imported_url
              : LinkMode.linked_url
            : LinkMode.imported_file);

      const metadata: Record<string, unknown> = {
        ...(typeof att.metadata === 'object' && att.metadata !== null
          ? (att.metadata as Record<string, unknown>)
          : {}),
        ...(title ? { title } : {}),
        ...(att.accessDate ? { accessDate: att.accessDate } : {}),
      };

      result.push({
        filename,
        url: fileUrl,
        fileId: resolvedFileId,
        size,
        mimeType,
        linkMode,
        attachmentType,
        metadata:
          Object.keys(metadata).length > 0
            ? (metadata as Prisma.InputJsonValue)
            : undefined,
        ...(fileUrl || resolvedFileId
          ? {
              revisions: {
                create: [
                  {
                    revisionNumber: 1,
                    url: fileUrl,
                    sizeBytes: size,
                    fileHash: (att.fileHash as string) || '',
                  },
                ],
              },
            }
          : {}),
      });
    }
  }

  if (result.length === 0 && (fallbackData?.fileUrl || fallbackFileId)) {
    const fileUrl =
      fallbackData?.fileUrl ||
      (fallbackFileId ? getFileContentPath(fallbackFileId) : '');
    const filename = fallbackData?.filename || 'document.pdf';
    const mimeType = fallbackData?.mimeType || 'application/pdf';
    const size = fallbackData?.size || 0;

    result.push({
      filename,
      url: fileUrl,
      fileId: fallbackFileId || null,
      size,
      mimeType,
      linkMode: 'imported_file',
      attachmentType: 'primary_pdf',
      revisions: {
        create: [
          {
            revisionNumber: 1,
            url: fileUrl,
            sizeBytes: size,
            fileHash: '',
          },
        ],
      },
    });
  }

  return result;
}

export interface ResolvedTag {
  id: string;
  type: TagType;
}

function buildTagTypeMap(
  rawTagList: (TagInput | null | undefined)[],
): Map<string, TagType> {
  const tagTypeMap = new Map<string, TagType>();
  if (!Array.isArray(rawTagList)) return tagTypeMap;
  for (const rt of rawTagList) {
    if (typeof rt === 'object' && rt !== null) {
      const tagName = (rt.name || rt.tag || '').trim();
      if (!tagName) continue;
      const typeVal =
        'type' in rt ? (rt as { type?: unknown }).type : undefined;
      let resolvedType: TagType | undefined;
      if (
        typeVal === 1 ||
        typeVal === 'automatic' ||
        typeVal === TagType.automatic
      ) {
        resolvedType = TagType.automatic;
      } else if (
        typeVal === 0 ||
        typeVal === 'manual' ||
        typeVal === TagType.manual
      ) {
        resolvedType = TagType.manual;
      }
      if (resolvedType) {
        tagTypeMap.set(tagName.toLowerCase(), resolvedType);
        const normalized = cleanSingleTag(tagName);
        if (normalized) {
          tagTypeMap.set(normalized.toLowerCase(), resolvedType);
        }
      }
    }
  }
  return tagTypeMap;
}

export async function resolveOrCreateTags(
  client: Prisma.TransactionClient | PrismaService,
  userId: string,
  rawTagList: (TagInput | null | undefined)[],
  defaultTagType: TagType = TagType.manual,
  projectId?: string | null,
): Promise<ResolvedTag[]> {
  const normalizedTagNames = normalizeTags(rawTagList).slice(0, 30);
  if (normalizedTagNames.length === 0) return [];

  const effectiveProjectId =
    projectId &&
    projectId !== 'user' &&
    projectId !== 'me' &&
    projectId !== 'personal' &&
    isUuid(projectId)
      ? projectId
      : null;

  const scopeWhere: Prisma.TagWhereInput = effectiveProjectId
    ? { projectId: effectiveProjectId }
    : { userId, projectId: null };

  const tagTypeMap = buildTagTypeMap(rawTagList);

  if (
    typeof client.tag?.createMany === 'function' &&
    typeof client.tag?.findMany === 'function'
  ) {
    const preExistingTags =
      (await client.tag.findMany({
        where: {
          ...scopeWhere,
          OR: normalizedTagNames.map((name) => ({
            name: { equals: name, mode: 'insensitive' as const },
          })),
        },
        select: { id: true, name: true, type: true },
      })) || [];

    const existingLowerNames = new Set(
      preExistingTags
        .map((t: { id: string; name?: string }) =>
          typeof t.name === 'string' ? t.name.toLowerCase() : '',
        )
        .filter(Boolean),
    );
    const missingTagNames = normalizedTagNames.filter(
      (name) => !existingLowerNames.has(name.toLowerCase()),
    );

    if (missingTagNames.length > 0) {
      await client.tag.createMany({
        data: missingTagNames.map((name) => ({
          userId,
          createdById: userId,
          name,
          type: tagTypeMap.get(name.toLowerCase()) || defaultTagType,
          projectId: effectiveProjectId,
        })),
        skipDuplicates: true,
      });
    }

    const allMatchingTags =
      missingTagNames.length > 0
        ? (await client.tag.findMany({
            where: {
              ...scopeWhere,
              OR: normalizedTagNames.map((name) => ({
                name: { equals: name, mode: 'insensitive' as const },
              })),
            },
            select: { id: true, name: true, type: true },
          })) || preExistingTags
        : preExistingTags;

    const dedupedByLower = new Map<string, ResolvedTag>();
    for (const t of allMatchingTags as Array<{
      id: string;
      name?: string;
      type?: TagType;
    }>) {
      const key = typeof t.name === 'string' ? t.name.toLowerCase() : t.id;
      if (!dedupedByLower.has(key)) {
        dedupedByLower.set(key, {
          id: t.id,
          type: tagTypeMap.get(key) || t.type || defaultTagType,
        });
      }
    }

    return Array.from(dedupedByLower.values());
  }

  // Fallback for lightweight mock clients that only implement findFirst + create
  const resolved: ResolvedTag[] = [];
  for (const tagName of normalizedTagNames) {
    const determinedType =
      tagTypeMap.get(tagName.toLowerCase()) || defaultTagType;
    let tag = await client.tag.findFirst({
      where: {
        ...scopeWhere,
        name: { equals: tagName, mode: 'insensitive' },
      },
    });
    if (!tag) {
      tag = await client.tag.create({
        data: {
          userId,
          createdById: userId,
          name: tagName,
          type: determinedType,
          projectId: effectiveProjectId,
        },
      });
    }
    resolved.push({ id: tag.id, type: determinedType });
  }
  return resolved;
}

export async function syncTagsForCatalogItem(
  client: Prisma.TransactionClient | PrismaService,
  userId: string,
  itemId: string,
  rawTags: (TagInput | null | undefined)[],
  defaultTagType: TagType = TagType.manual,
  projectId?: string | null,
): Promise<void> {
  const normalizedTagsList = normalizeTags(rawTags);
  if (normalizedTagsList.length === 0) {
    await client.itemTag.deleteMany({ where: { itemId } });
    return;
  }

  const resolvedTags = await resolveOrCreateTags(
    client,
    userId,
    rawTags,
    defaultTagType,
    projectId,
  );
  if (resolvedTags.length === 0) {
    await client.itemTag.deleteMany({ where: { itemId } });
    return;
  }

  await client.itemTag.deleteMany({
    where: {
      itemId,
      tagId: { notIn: resolvedTags.map((t) => t.id) },
    },
  });

  if (typeof client.itemTag?.createMany === 'function') {
    await client.itemTag.createMany({
      data: resolvedTags.map((t) => ({
        tagId: t.id,
        itemId,
        type: t.type,
      })),
      skipDuplicates: true,
    });
    return;
  }

  await Promise.all(
    resolvedTags.map((t) =>
      client.itemTag.upsert({
        where: { tagId_itemId: { tagId: t.id, itemId } },
        create: { tagId: t.id, itemId, type: t.type },
        update: { type: t.type },
      }),
    ),
  );
}

export function deriveFirstAuthor(data: {
  contributors?: Array<Record<string, unknown> | CreatorCreditInput>;
  creators?: Array<Record<string, unknown> | CreatorCreditInput>;
  authors?: Array<string | Record<string, unknown>>;
}): string | null {
  const structured =
    data.contributors && data.contributors.length > 0
      ? data.contributors
      : data.creators && data.creators.length > 0
        ? data.creators
        : null;
  if (structured) {
    const c0 = structured[0] as Record<string, unknown>;
    const authorName =
      (c0.lastName as string) ||
      (c0.fullName as string) ||
      (c0.name as string) ||
      '';
    if (!authorName) return null;
    return structured.length > 1 ? `${authorName} et al.` : authorName;
  }
  if (data.authors && data.authors.length > 0) {
    const firstAuthor = data.authors[0];
    const authorStr: string =
      typeof firstAuthor === 'string'
        ? firstAuthor
        : String(
            firstAuthor?.name ||
              firstAuthor?.fullName ||
              firstAuthor?.lastName ||
              '',
          );
    const parsed0 = parseCreatorString(authorStr, 0);
    const authorName = parsed0.lastName || parsed0.fullName;
    if (!authorName) return null;
    return data.authors.length > 1 ? `${authorName} et al.` : authorName;
  }
  return null;
}

const ALL_MAPPED_PUB_TITLE_KEYS: ReadonlyArray<string> = Array.from(
  new Set(
    Object.values(BASE_FIELD_MAPPINGS)
      .map((m) => m.publicationTitle)
      .filter(Boolean),
  ),
);

const ALL_MAPPED_PUBLISHER_KEYS: ReadonlyArray<string> = Array.from(
  new Set(
    Object.values(BASE_FIELD_MAPPINGS)
      .map((m) => m.publisher)
      .filter(Boolean),
  ),
);

export function prepareContributorsToCreate(
  data: {
    contributors?: CreatorCreditInput[];
    creators?: CreatorCreditInput[];
    authors?: string[];
  },
  itemType?: string,
): Array<{
  creatorType: string;
  fieldMode?: number;
  firstName: string;
  lastName: string;
  fullName: string;
  shortName?: string;
  orderIndex: number;
}> | null {
  const structuredList =
    data.contributors !== undefined
      ? data.contributors
      : data.creators !== undefined
        ? data.creators
        : undefined;

  if (structuredList !== undefined) {
    return (structuredList || [])
      .filter((c: CreatorCreditInput) => {
        const fullName =
          c.fullName ||
          [c.firstName, c.lastName].filter(Boolean).join(' ') ||
          c.name ||
          '';
        return Boolean(fullName && !isNoiseAuthorName(fullName));
      })
      .map((c: CreatorCreditInput, index: number) => {
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
          creatorType: resolveCanonicalCreatorRole(c.creatorType, { itemType }),
          fieldMode: c.fieldMode !== undefined ? Number(c.fieldMode) : 0,
          firstName: first,
          lastName: last,
          fullName,
          shortName: c.shortName || '',
          orderIndex: c.orderIndex !== undefined ? c.orderIndex : index,
        };
      });
  }

  if (data.authors !== undefined) {
    return (data.authors || [])
      .flatMap((authorName: string) => splitAuthorString(authorName))
      .map((authorName: string, index: number) => {
        const parsed = parseCreatorString(authorName, index);
        return {
          creatorType: parsed.creatorType,
          firstName: parsed.firstName,
          lastName: parsed.lastName,
          fullName: parsed.fullName,
          orderIndex: parsed.orderIndex,
        };
      });
  }

  return null;
}

export interface CanonicalCommandFields {
  itemType: string;
  baseMap: Record<string, string>;
  effectiveExtraFields: Record<string, unknown>;
  rawTitle: string | undefined;
  rawPubTitle: string | null | undefined;
  rawPublisher: string | null | undefined;
  rawPubDate: string | null | undefined;
  extractedYear: number | null;
  rawPlace: string | null | undefined;
  rawVolume: string | number | null | undefined;
  rawIssue: string | number | null | undefined;
  rawPages: string | number | null | undefined;
  rawAbstract: string | null | undefined;
  rawJournalAbbr: string | null | undefined;
  rawRights: string | null | undefined;
  rawLicense: string | null | undefined;
  rawEdition: string | number | null | undefined;
  rawAccessDate: string | null | undefined;
  rawUrl: string | null | undefined;
  rawCitationKey: string | null | undefined;
  rawTypeField: string | undefined;
}

/**
 * Shared canonical resolver for both Create and Update command payloads.
 * Eliminates duplicate Zotero v42 BASE_FIELD_MAPPINGS and FIELD_ALIASES lookup logic
 * while preserving exact partial-update (`undefined`) vs full-create semantics.
 */
export function resolveCanonicalCommandFields(
  data: CreateItemData | UpdateItemData,
  targetItemType: string,
  existingParsedFields?: Record<string, unknown> | null,
): CanonicalCommandFields {
  const dataRecord = data as Record<string, unknown>;
  const dataExtra =
    data.extraFields && typeof data.extraFields === 'object'
      ? data.extraFields
      : {};
  const getVal = (key: string): unknown =>
    dataRecord[key] !== undefined ? dataRecord[key] : dataExtra[key];

  const firstDefined = (keys: Array<string | undefined>): unknown => {
    for (const k of keys) {
      if (!k) continue;
      const val = getVal(k);
      if (val !== undefined) return val;
    }
    return undefined;
  };

  const toNullableStr = (val: unknown): string | null | undefined =>
    val === undefined ? undefined : val === null ? null : String(val);

  const baseMap = getEffectiveBaseFieldMap(targetItemType);
  const effectiveExtraFields = extractNonColumnExtraFields(
    data,
    existingParsedFields ?? null,
  );

  const rawPubTitle = toNullableStr(
    firstDefined([
      'publicationTitle',
      'journal',
      baseMap.publicationTitle,
      ...ALL_MAPPED_PUB_TITLE_KEYS,
    ]),
  );

  const rawPublisher = toNullableStr(
    firstDefined([
      'publisher',
      'repository',
      baseMap.publisher,
      ...ALL_MAPPED_PUBLISHER_KEYS,
    ]),
  );

  const mappedTitleKey = baseMap.title;
  const rawTitleVal = firstDefined([
    'title',
    mappedTitleKey,
    'caseName',
    'nameOfAct',
    'subject',
  ]);
  const rawTitle =
    rawTitleVal !== undefined && rawTitleVal !== null
      ? String(rawTitleVal)
      : undefined;

  if (
    mappedTitleKey &&
    rawTitle?.trim() &&
    effectiveExtraFields[mappedTitleKey] === undefined
  ) {
    effectiveExtraFields[mappedTitleKey] =
      getVal(mappedTitleKey) || rawTitle.trim();
  }

  const rawPubDate = toNullableStr(
    firstDefined(['publicationDate', 'date', baseMap.date, 'filingDate']),
  );

  const parsedYearMatch =
    rawPubDate !== undefined && rawPubDate !== null
      ? String(rawPubDate).match(/(?:^|[^\d])(1[7-9]\d{2}|20\d{2})(?:[^\d]|$)/)
      : null;
  const extractedYear = parsedYearMatch
    ? parseInt(parsedYearMatch[1], 10)
    : null;

  const rawPlace = toNullableStr(firstDefined(['place', baseMap.place]));
  const rawVolume = firstDefined(['volume', baseMap.volume]) as
    string | number | null | undefined;
  const rawIssue = firstDefined(['issue', baseMap.issue, baseMap.number]) as
    string | number | null | undefined;
  const rawPages = firstDefined(['pages', baseMap.pages]) as
    string | number | null | undefined;
  const rawAbstract = toNullableStr(firstDefined(['abstract', 'abstractNote']));
  const rawJournalAbbr = toNullableStr(
    firstDefined(['journalAbbr', 'journalAbbreviation']),
  );
  const rawRights = toNullableStr(firstDefined(['rights', 'license']));
  const rawLicense = toNullableStr(firstDefined(['license', 'rights']));
  const rawEdition = firstDefined(['edition']) as
    string | number | null | undefined;
  const rawAccessDate = toNullableStr(firstDefined(['accessDate']));
  const rawUrl = toNullableStr(firstDefined(['url', 'URL']));

  const extraKv = extractExtraKeyValues(data.extra);
  const rawCitationKey =
    toNullableStr(firstDefined(['citationKey', 'citeKey'])) ??
    extraKv['citation-key'] ??
    extraKv['citationkey'] ??
    extraKv['bibtex'] ??
    extraKv['tex.ids']?.split(/[,\s]+/)[0];

  const candidateType = toNullableStr(firstDefined(['type']))?.trim() || '';
  const rawTypeField =
    candidateType &&
    candidateType.toLowerCase() !== targetItemType.toLowerCase()
      ? candidateType
      : undefined;

  const harmonizedProbe = harmonizeZoteroFields(
    {
      ...dataRecord,
      itemType: targetItemType,
      extraFields: { ...effectiveExtraFields },
    },
    { itemType: targetItemType, syncExtraFields: true },
  );
  if (
    harmonizedProbe.extraFields &&
    typeof harmonizedProbe.extraFields === 'object'
  ) {
    for (const [k, v] of Object.entries(
      harmonizedProbe.extraFields as Record<string, unknown>,
    )) {
      if (
        v !== undefined &&
        effectiveExtraFields[k] === undefined &&
        !ITEM_COLUMN_METADATA_FIELDS.has(k) &&
        !FIELD_ALIASES[k]
      ) {
        effectiveExtraFields[k] = v;
      }
    }
  }

  return {
    itemType: targetItemType,
    baseMap,
    effectiveExtraFields,
    rawTitle,
    rawPubTitle,
    rawPublisher,
    rawPubDate,
    extractedYear,
    rawPlace,
    rawVolume,
    rawIssue,
    rawPages,
    rawAbstract,
    rawJournalAbbr,
    rawRights,
    rawLicense,
    rawEdition,
    rawAccessDate,
    rawUrl,
    rawCitationKey,
    rawTypeField,
  };
}

const DIRECT_STRING_METADATA_KEYS = [
  'section',
  'partNumber',
  'partTitle',
  'series',
  'seriesTitle',
  'seriesText',
  'language',
  'shortTitle',
  'libraryCatalog',
  'archive',
  'archiveLocation',
  'callNumber',
  'openAccessPdfUrl',
] as const;

/**
 * Composable partial metadata builder used by both Create (`mode: 'create'`)
 * and Update (`mode: 'update'`). Eliminates 180+ lines of duplicate property
 * ternary assignments.
 */
function buildMetadataPartial(params: {
  mode: 'create' | 'update';
  baseMeta: Record<string, unknown>;
  data: CreateItemData | UpdateItemData;
  canonical: CanonicalCommandFields;
  ids: ReturnType<typeof normalizeItemIdentifiers>;
  rawTags?: (TagInput | null | undefined)[];
  existingRawExtra?: string | null;
  uploadedById?: string;
}): Record<string, unknown> {
  const {
    mode,
    baseMeta,
    data,
    canonical,
    ids,
    rawTags,
    existingRawExtra,
    uploadedById,
  } = params;
  const isCreate = mode === 'create';
  const dataRecord = data as Record<string, unknown>;
  const dataExtra =
    data.extraFields && typeof data.extraFields === 'object'
      ? data.extraFields
      : {};

  const getRawField = (key: string): unknown =>
    dataRecord[key] !== undefined ? dataRecord[key] : dataExtra[key];

  const formatTrimmedOrNull = (
    val: string | number | null | undefined,
  ): string | null | undefined => {
    if (val === undefined) return isCreate ? '' : undefined;
    if (val === null) return isCreate ? '' : null;
    return String(val).trim();
  };

  const formatPositiveCount = (val: unknown): number | null | undefined => {
    if (val === undefined) return isCreate ? null : undefined;
    return val && Number(val) > 0 ? Number(val) : null;
  };

  const result: Record<string, unknown> = { ...baseMeta };
  const setIfDefined = (key: string, val: unknown) => {
    if (val !== undefined) result[key] = val;
  };

  setIfDefined(
    'publicationTitle',
    isCreate ? (canonical.rawPubTitle ?? '').trim() : canonical.rawPubTitle,
  );

  const createDateStr =
    (canonical.rawPubDate ?? '').trim() || (data.year ? String(data.year) : '');
  if (isCreate) {
    result.publicationDate = createDateStr;
    result.date = createDateStr;
  } else if (canonical.rawPubDate !== undefined) {
    result.publicationDate = canonical.rawPubDate;
    result.date = canonical.rawPubDate;
  }

  setIfDefined(
    'publisher',
    isCreate ? (canonical.rawPublisher ?? '').trim() : canonical.rawPublisher,
  );
  setIfDefined(
    'place',
    isCreate ? (canonical.rawPlace ?? '').trim() : canonical.rawPlace,
  );
  setIfDefined('volume', formatTrimmedOrNull(canonical.rawVolume));
  setIfDefined('issue', formatTrimmedOrNull(canonical.rawIssue));
  setIfDefined('pages', formatTrimmedOrNull(canonical.rawPages));
  setIfDefined('edition', formatTrimmedOrNull(canonical.rawEdition));
  if (canonical.rawTypeField !== undefined) {
    result.type = canonical.rawTypeField;
  }

  for (const key of DIRECT_STRING_METADATA_KEYS) {
    const rawVal = getRawField(key);
    if (isCreate) {
      result[key] =
        typeof rawVal === 'string'
          ? rawVal.trim()
          : typeof rawVal === 'number'
            ? String(rawVal)
            : '';
    } else if (dataRecord[key] !== undefined) {
      result[key] = dataRecord[key];
    }
  }

  const rawSeriesNumber = getRawField('seriesNumber');
  if (isCreate) {
    result.seriesNumber =
      rawSeriesNumber !== undefined && rawSeriesNumber !== null
        ? String(rawSeriesNumber).trim()
        : '';
  } else if (data.seriesNumber !== undefined) {
    result.seriesNumber = data.seriesNumber;
  }

  setIfDefined(
    'abstractNote',
    isCreate ? (canonical.rawAbstract ?? '') : canonical.rawAbstract,
  );
  setIfDefined('issn', isCreate ? (ids.issn ?? '') : ids.issn);
  setIfDefined('isbn', isCreate ? (ids.isbn ?? '') : ids.isbn);
  setIfDefined('pmid', isCreate ? (ids.pmid ?? '') : ids.pmid);
  setIfDefined('pmcid', isCreate ? (ids.pmcid ?? '') : ids.pmcid);
  setIfDefined('arxivId', isCreate ? (ids.arxivId ?? '') : ids.arxivId);
  setIfDefined(
    'journalAbbr',
    isCreate
      ? (canonical.rawJournalAbbr ?? '').trim()
      : canonical.rawJournalAbbr,
  );
  setIfDefined(
    'rights',
    isCreate ? (canonical.rawRights ?? '').trim() : canonical.rawRights,
  );
  setIfDefined(
    'license',
    isCreate ? (canonical.rawLicense ?? '').trim() : data.license,
  );

  if (isCreate) {
    result.accessedAt =
      data.accessedAt ??
      (canonical.rawAccessDate
        ? parseAccessDate(canonical.rawAccessDate)
        : null);
  } else if (data.accessedAt !== undefined) {
    result.accessedAt = data.accessedAt;
  } else if (canonical.rawAccessDate !== undefined) {
    result.accessedAt =
      parseAccessDate(canonical.rawAccessDate ?? undefined) ?? null;
  }

  setIfDefined('citationCount', formatPositiveCount(data.citationCount));
  setIfDefined('referenceCount', formatPositiveCount(data.referenceCount));

  if (!isCreate && data.isMyPublication !== undefined) {
    result.isMyPublication = data.isMyPublication;
  }

  const { effectiveExtraFields } = canonical;
  if (isCreate) {
    result.extra =
      resolveExtraPlainText(data.extra, null, effectiveExtraFields) ?? '';
    if (uploadedById) result.uploadedById = uploadedById;
  } else if (data.extra !== undefined || effectiveExtraFields) {
    result.extra =
      resolveExtraPlainText(
        data.extra,
        existingRawExtra,
        effectiveExtraFields,
      ) ??
      existingRawExtra ??
      '';
  }

  if (effectiveExtraFields && typeof effectiveExtraFields === 'object') {
    Object.assign(result, effectiveExtraFields);
  }
  if (data.metadata && typeof data.metadata === 'object') {
    Object.assign(result, data.metadata);
  }

  if (data.isRetracted !== undefined) {
    result.isRetracted = Boolean(data.isRetracted);
    result.retractionNature = data.retractionNature ?? null;
    result.retractionDetails = data.retractionDetails ?? null;
    result.retractionCheckedAt =
      data.retractionCheckedAt ?? new Date().toISOString();
  }

  if (isCreate) {
    if (data.relations) result.relations = data.relations;
    if ('seeAlso' in data && data.seeAlso) result.seeAlso = data.seeAlso;
  }

  if (rawTags !== undefined) {
    const normalizedTags = normalizeTags(rawTags);
    result.tags = normalizedTags;
    result.keywords = normalizedTags;
    result.labels = normalizedTags;
  }

  return result;
}

export async function buildCommandCreateInput(
  userId: string,
  data: CreateItemData,
  client: Prisma.TransactionClient | PrismaService,
  projectId?: string,
): Promise<{
  createData: Prisma.ItemUncheckedCreateInput;
  resolvedFileId: string | null;
}> {
  const rawFileId =
    data.fileId ||
    data.fileUrl?.match(/\/api\/files\/([a-zA-Z0-9-]+)\/content/)?.[1] ||
    null;
  const resolvedFileId = rawFileId && isUuid(rawFileId) ? rawFileId : null;

  const notes = prepareNotesToCreate(
    data.notes,
    userId,
    data.uploadedById || userId,
  );
  const attachmentsToCreate = prepareAttachmentsToCreate(
    data.attachments,
    resolvedFileId,
    data,
  );

  const firstAuthor = deriveFirstAuthor(data);
  const hasFile = attachmentsToCreate.some(
    (att) =>
      Boolean(att.fileId) ||
      Boolean(att.url && typeof att.url === 'string' && att.url.length > 0) ||
      att.attachmentType === 'primary_pdf',
  );

  const effectiveProjectId =
    (projectId && projectId !== 'user' && isUuid(projectId)
      ? projectId
      : undefined) ||
    (data.projectId && isUuid(data.projectId) ? data.projectId : null);

  const ids = normalizeItemIdentifiers(data);
  const rawTagList = [
    ...(data.tags || []),
    ...(data.keywords || []),
    ...(data.labels || []),
  ];
  const defaultTagType =
    (data.keywords && data.keywords.length > 0) ||
    (data.labels && data.labels.length > 0)
      ? TagType.automatic
      : TagType.manual;
  const resolvedTags = await resolveOrCreateTags(
    client,
    userId,
    rawTagList,
    defaultTagType,
    effectiveProjectId,
  );

  const resolvedItemType = data.itemType ?? data.type ?? 'journalArticle';
  const canonical = resolveCanonicalCommandFields(data, resolvedItemType, null);
  const { effectiveExtraFields } = canonical;

  const resolvedCreateTitle =
    sanitizeItemTitle(canonical.rawTitle) || 'Untitled Item';
  if (
    canonical.baseMap.title &&
    resolvedCreateTitle !== 'Untitled Item' &&
    effectiveExtraFields[canonical.baseMap.title] === undefined
  ) {
    effectiveExtraFields[canonical.baseMap.title] = resolvedCreateTitle;
  }

  const resolvedPubTitle = (canonical.rawPubTitle ?? '').trim();
  const resolvedCreateYear: number | null =
    data.year !== undefined && data.year !== null
      ? Number(data.year)
      : canonical.extractedYear;

  const metadataPayload = buildMetadataPartial({
    mode: 'create',
    baseMeta: {},
    data,
    canonical,
    ids,
    rawTags: rawTagList,
    uploadedById: data.uploadedById || userId,
  });

  const contributorsToCreate = prepareContributorsToCreate(
    data,
    resolvedItemType,
  );

  const uniqueCollectionIds = Array.from(
    new Set(
      [
        ...(Array.isArray(data.collectionIds) ? data.collectionIds : []),
        ...(data.collectionId ? [data.collectionId] : []),
      ].filter(
        (id): id is string => typeof id === 'string' && id.trim().length > 0,
      ),
    ),
  );

  const createData: Prisma.ItemUncheckedCreateInput = {
    userId,
    title: resolvedCreateTitle,
    itemType: resolvedItemType,
    ...(resolvedPubTitle ? { publicationTitle: resolvedPubTitle } : {}),
    year: resolvedCreateYear,
    doi: ids.doi ?? '',
    abstract: canonical.rawAbstract ?? '',
    url: (canonical.rawUrl ?? '').trim(),
    citationKey: (canonical.rawCitationKey ?? '').trim(),
    metadata: metadataPayload as Prisma.InputJsonValue,
    hasFile,
    attachmentCount: attachmentsToCreate.length,
    noteCount: notes.length,
    firstAuthor,
    projectId:
      (projectId && projectId !== 'user' && isUuid(projectId)
        ? projectId
        : undefined) ||
      (data.projectId && isUuid(data.projectId) ? data.projectId : null),
    version: 1,
    ...(uniqueCollectionIds.length > 0
      ? {
          collectionItems: {
            create: uniqueCollectionIds.map((cid, idx) => ({
              collectionId: cid,
              sortOrder: idx,
            })),
          },
        }
      : {}),
    ...(contributorsToCreate && contributorsToCreate.length > 0
      ? { contributors: { create: contributorsToCreate } }
      : {}),
    ...(resolvedTags.length > 0
      ? {
          itemTags: {
            create: resolvedTags.map(({ id, type }) => ({ tagId: id, type })),
          },
        }
      : {}),
    ...(attachmentsToCreate.length > 0
      ? { attachments: { create: attachmentsToCreate } }
      : {}),
    ...(notes.length > 0 ? { notesList: { create: notes } } : {}),
  };

  return { createData, resolvedFileId };
}

export function buildCommandUpdateInput(
  userId: string,
  existing: ItemDetail | Record<string, unknown>,
  data: UpdateItemData,
  options?: { skipVersionIncrement?: boolean },
): {
  updateData: Prisma.ItemUpdateInput;
  cleanIds: {
    doi?: string;
    arxivId?: string;
    pmid?: string;
    pmcid?: string;
    isbn?: string;
    issn?: string;
  };
  rawTags?: (TagInput | null | undefined)[];
} {
  const ids = normalizeItemIdentifiers(data);
  const targetItemType = (data.itemType ??
    data.type ??
    existing.itemType ??
    existing.type ??
    'journalArticle') as string;

  const rawTags = data.tags || data.keywords || data.labels;
  const { cleanExtra: existingRawExtra, extraFields: existingParsedFields } =
    unpackExtraFromDb(existing.extra as string | null | undefined);

  const canonical = resolveCanonicalCommandFields(
    data,
    targetItemType,
    existingParsedFields,
  );

  const cleanAbstract =
    canonical.rawAbstract !== undefined
      ? (cleanAbstractText(canonical.rawAbstract) ?? canonical.rawAbstract)
      : existing.abstract;

  const newNotesToCreate = prepareNotesToCreate(
    data.notes,
    userId,
    data.userId || (existing.uploadedById as string | undefined) || userId,
    existing.notesList,
  );

  const newAttachmentsToCreate =
    Array.isArray(data.attachments) && data.attachments.length > 0
      ? prepareAttachmentsToCreate(
          data.attachments.filter(
            (a: Record<string, unknown> | null | undefined) => !a?.id,
          ),
          null,
        )
      : [];

  const existingMeta =
    existing.metadata &&
    typeof existing.metadata === 'object' &&
    !Array.isArray(existing.metadata)
      ? (existing.metadata as Record<string, unknown>)
      : typeof existing.metadata === 'string' &&
          existing.metadata.trim().startsWith('{')
        ? (() => {
            try {
              return JSON.parse(existing.metadata);
            } catch {
              return {};
            }
          })()
        : {};

  const updatedMetadata = buildMetadataPartial({
    mode: 'update',
    baseMeta: existingMeta,
    data,
    canonical,
    ids,
    rawTags,
    existingRawExtra,
  });

  const contributorsToUpdate = prepareContributorsToCreate(
    data,
    targetItemType,
  );

  const buildCollectionUpdate = () => {
    if (data.collectionIds !== undefined) {
      const unique = Array.from(
        new Set(
          (Array.isArray(data.collectionIds) ? data.collectionIds : []).filter(
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
        : { deleteMany: {} };
    }
    if (data.collectionId !== undefined) {
      return data.collectionId &&
        typeof data.collectionId === 'string' &&
        data.collectionId.trim().length > 0
        ? {
            deleteMany: {},
            create: {
              collection: { connect: { id: data.collectionId.trim() } },
              sortOrder: 0,
            },
          }
        : { deleteMany: {} };
    }
    return undefined;
  };

  const collectionItemsPatch = buildCollectionUpdate();

  const updateData: Prisma.ItemUpdateInput = {
    title:
      canonical.rawTitle !== undefined
        ? sanitizeItemTitle(canonical.rawTitle) || (existing.title as string)
        : (existing.title as string),
    itemType: targetItemType,
    ...(canonical.rawPubTitle !== undefined
      ? { publicationTitle: canonical.rawPubTitle }
      : {}),
    year: (data.year !== undefined
      ? data.year
      : canonical.extractedYear !== null
        ? canonical.extractedYear
        : existing.year) as number | null | undefined,
    doi: (ids.doi !== undefined ? ids.doi : existing.doi) as
      string | null | undefined,
    abstract: cleanAbstract as string | null | undefined,
    url: (canonical.rawUrl !== undefined ? canonical.rawUrl : existing.url) as
      string | null | undefined,
    citationKey: (canonical.rawCitationKey !== undefined
      ? canonical.rawCitationKey
      : existing.citationKey) as string | null | undefined,
    metadata: updatedMetadata as Prisma.InputJsonValue,
    ...(data.contributors !== undefined ||
    data.creators !== undefined ||
    data.authors !== undefined
      ? { firstAuthor: deriveFirstAuthor(data) }
      : {}),
    ...(collectionItemsPatch ? { collectionItems: collectionItemsPatch } : {}),
    ...(contributorsToUpdate !== null
      ? {
          contributors: {
            deleteMany: {},
            create: contributorsToUpdate,
          },
        }
      : {}),
    ...(newNotesToCreate.length > 0
      ? {
          notesList: { create: newNotesToCreate },
          noteCount:
            (Array.isArray(existing.notesList)
              ? existing.notesList.length
              : typeof existing.noteCount === 'number'
                ? existing.noteCount
                : 0) + newNotesToCreate.length,
        }
      : {}),
    ...(newAttachmentsToCreate.length > 0
      ? { attachments: { create: newAttachmentsToCreate } }
      : {}),
    ...(options?.skipVersionIncrement ? {} : { version: { increment: 1 } }),
  };

  return {
    updateData,
    cleanIds: ids,
    rawTags,
  };
}

const IDENTIFIER_URI_BUILDERS: ReadonlyArray<{
  type: 'doi' | 'arxiv' | 'pmid' | 'pmcid' | 'isbn' | 'issn';
  key: keyof ReturnType<typeof normalizeItemIdentifiers>;
  buildUri: (val: string) => string;
}> = [
  { type: 'doi', key: 'doi', buildUri: (v) => `https://doi.org/${v}` },
  {
    type: 'arxiv',
    key: 'arxivId',
    buildUri: (v) => `https://arxiv.org/abs/${v}`,
  },
  {
    type: 'pmid',
    key: 'pmid',
    buildUri: (v) => `https://pubmed.ncbi.nlm.nih.gov/${v}/`,
  },
  {
    type: 'pmcid',
    key: 'pmcid',
    buildUri: (v) => `https://www.ncbi.nlm.nih.gov/pmc/articles/${v}/`,
  },
  { type: 'isbn', key: 'isbn', buildUri: (v) => `urn:isbn:${v}` },
  { type: 'issn', key: 'issn', buildUri: (v) => `urn:issn:${v}` },
];

export function calculateIdentifierChanges(
  cleanIds: {
    doi?: string;
    arxivId?: string;
    pmid?: string;
    pmcid?: string;
    isbn?: string;
    issn?: string;
  },
  existing: ItemDetail | Record<string, unknown>,
): Array<{ type: string; value: string; canonicalUri: string }> {
  const existingArxivIdentifier = (
    existing.identifiers as Array<{ type: string; value?: string }> | undefined
  )?.find((identifierItem) => identifierItem.type === 'arxiv')?.value;

  const changes: Array<{ type: string; value: string; canonicalUri: string }> =
    [];

  for (const { type, key, buildUri } of IDENTIFIER_URI_BUILDERS) {
    const newVal = cleanIds[key];
    const currentVal =
      type === 'arxiv' ? existingArxivIdentifier : existing[key];
    if (newVal !== undefined && newVal !== currentVal) {
      changes.push({
        type,
        value: newVal,
        canonicalUri: newVal ? buildUri(newVal) : '',
      });
    }
  }

  return changes;
}
