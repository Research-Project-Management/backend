import { Prisma, LinkMode, AttachmentType, AnnotationType, TagType } from '@prisma/client';
import { PrismaService } from '@/core';
import {
  normalizeAcademicTags,
  cleanSingleTag,
  buildTipTapDocFromText,
  parseCreatorString,
  splitAuthorString,
  isNoiseAuthorName,
  resolveCanonicalCreatorRole,
  mergeCanonicalCreators,
  normalizeDoi,
  normalizeArxivId,
  normalizePmid,
  normalizePmcid,
  normalizeIsbn,
  normalizeIssn,
  cleanBannedString,
  convertAcademicHtmlToMarkdown,
} from '@/modules/library/core';
import {
  ITEM_COLUMN_METADATA_FIELDS,
  FIELD_ALIASES,
} from '@/modules/library/catalog/types/items.constants';
import { TagInput } from '@/modules/library/catalog/types/tags.types';
import { CreatorCreditInput } from '@/modules/library/core/types/bibliographic.types';
import { getFileContentPath } from '@/modules/storage/storage.port';
import { isUUID } from 'class-validator';
export { buildTipTapDocFromText };
export const isUuid = (val: unknown): val is string =>
  typeof val === 'string' && Boolean(val) && isUUID(val);
export {
  cleanSingleIdentifier,
  extractExtraKeyValues,
  normalizeItemIdentifiers,
} from './identifier-change.helper';
export function resolveExtraPlainText(
  extraInput?: string | null,
  existingExtra?: string | null,
  patches?: Record<string, unknown> | null,
): string | undefined {
  const rawCandidate =
    (extraInput !== undefined && extraInput !== null
      ? extraInput
      : existingExtra) ?? '';
  const cleanRaw = typeof rawCandidate === 'string' ? rawCandidate.trim() : '';
  if (!patches || Object.keys(patches).length === 0) {
    return cleanRaw || undefined;
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
        (typeof val === 'string' && val !== '') ||
        typeof val === 'number' ||
        typeof val === 'boolean'
      ) {
        updatedLines.push(`${linePrefix}: ${String(val)}`);
      }
    } else {
      updatedLines.push(line);
    }
  }
  return updatedLines.join('\n').trim() || undefined;
}
const IGNORED_SYSTEM_KEYS = new Set([
  'id', 'userId', 'projectId', 'createdById', 'uploadedById',
  'createdAt', 'updatedAt', 'deletedAt', 'version', '_version',
  'expectedVersion', 'isDeleted', 'silent', 'creators', 'authors',
  'contributors', 'editors', 'tags', 'labels', 'itemTags', 'zoteroTags',
  'keywords', 'keywordsList', 'attachments', 'primaryFile', 'filename',
  'notes', 'notesList', 'collectionId', 'collectionIds', 'collections',
  'collectionItems', 'userStates', 'states', 'readStatus', 'rating',
  'lastReadAt', 'extraFields', 'fileId', 'fileUrl', 'size', 'mimeType',
  'hasFile', 'attachmentCount', 'noteCount', 'firstAuthor', 'outgoingRel',
  'incomingRel', 'relations', 'seeAlso', 'identifiers', 'ingestionRuns',
  'itemMetadata', 'publications', 'crossrefEnriched',  'isRetracted', 'retraction', 'retractionStatus', 'retractionDate',
  'retractionNature', 'retractionReasons', 'retractionNoticeDoi',
  'retractionDetails', 'retractionCheckedAt', 'isMyPublication',
  'publicationConfirmedAt', 'ingestionStatus', 'extractionStatus',
  'verificationScore', 'isVerified', 'matchedSignals', 'missingFields',
  'isSelfSufficient', 'qualityScore', 'engineUsed', 'provenance',
  'fieldProvenance', 'sourceProvider', 'source', 'sources', 'confidenceScore',
  'originProvider', 'canonicalId', 'canonicalUrl', 'resolvedAt', 'warnings',
  'disambiguationWarning', 'rejectedCitedDoi', 'wafKind', 'promptUploadPdf',
  'dismissedDuplicateIds', 'mergedCitationKeys', 'mergedFromIds',
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
  projectId?: string | null,
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
      const baseTags = normalizeAcademicTags([
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
        projectId: projectId ?? null,
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
  userId?: string,
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
      const annotationsToCreate =
        Array.isArray(att.annotations) && att.annotations.length > 0
          ? att.annotations
              .filter(
                (ann: unknown) =>
                  ann &&
                  typeof ann === 'object' &&
                  !(ann as Record<string, unknown>).deletedAt,
              )
              .map((rawAnn: unknown) => {
                const ann = rawAnn as Record<string, unknown>;
                return {
                  type: (ann.type as AnnotationType) || AnnotationType.highlight,
                  color: (ann.color as string) || '#ffeb3b',
                  pageIndex: typeof ann.pageIndex === 'number' ? ann.pageIndex : 0,
                  pageLabel: typeof ann.pageLabel === 'string' ? ann.pageLabel : '',
                  annotationSortIndex:
                    typeof ann.annotationSortIndex === 'string'
                      ? ann.annotationSortIndex
                      : '',
                  rectCoords:
                    ann.rectCoords !== undefined
                      ? (ann.rectCoords as Prisma.InputJsonValue)
                      : Prisma.JsonNull,
                  quoteText:
                    typeof ann.quoteText === 'string' ? ann.quoteText : null,
                  comment: typeof ann.comment === 'string' ? ann.comment : '',
                  tags: Array.isArray(ann.tags)
                    ? (ann.tags as string[]).filter((t): t is string => typeof t === 'string')
                    : [],
                  authorId:
                    typeof ann.authorId === 'string' && isUuid(ann.authorId)
                      ? ann.authorId
                      : userId && isUuid(userId)
                        ? userId
                        : '00000000-0000-0000-0000-000000000000',
                  version: 1,
                };
              })
          : [];
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
        ...(annotationsToCreate.length > 0
          ? {
              annotations: {
                create: annotationsToCreate,
              },
            }
          : {}),
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
  if (
    result.length === 0 &&
    (fallbackFileId ||
      (fallbackData?.fileUrl && !/^https?:\/\//i.test(fallbackData.fileUrl)))
  ) {
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
export function buildTagTypeMap(
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
  const normalizedTagNames = normalizeAcademicTags(rawTagList).slice(0, 30);
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
  const tagOrFilter = normalizedTagNames.map((name) => ({
    name: { equals: name, mode: 'insensitive' as const },
  }));
  const preExistingTags =
    (await client.tag.findMany({
      where: {
        ...scopeWhere,
        OR: tagOrFilter,
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
            OR: tagOrFilter,
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
export async function syncTagsForCatalogItem(
  client: Prisma.TransactionClient | PrismaService,
  userId: string,
  itemId: string,
  rawTags: (TagInput | null | undefined)[],
  defaultTagType: TagType = TagType.manual,
  projectId?: string | null,
): Promise<void> {
  const normalizedTagsList = normalizeAcademicTags(rawTags);
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
  await client.itemTag.createMany({
    data: resolvedTags.map((t) => ({
      tagId: t.id,
      itemId,
      type: t.type,
    })),
    skipDuplicates: true,
  });
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
    const firstAuthor = data.authors[0] as
      | string
      | { name?: string; fullName?: string; lastName?: string }
      | undefined;
    const authorStr: string =
      typeof firstAuthor === 'string'
        ? firstAuthor
        : firstAuthor?.name ||
          firstAuthor?.fullName ||
          firstAuthor?.lastName ||
          '';
    const parsed0 = parseCreatorString(authorStr, 0);
    const authorName = parsed0.lastName || parsed0.fullName;
    if (!authorName) return null;
    return data.authors.length > 1 ? `${authorName} et al.` : authorName;
  }
  return null;
}
export function prepareContributorsToCreate(
  data: {
    contributors?: CreatorCreditInput[];
    creators?: CreatorCreditInput[];
    authors?: string[];
    editors?: string[];
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
  if (
    data.contributors === undefined &&
    data.creators === undefined &&
    data.authors === undefined &&
    data.editors === undefined
  ) {
    return null;
  }
  const merged = mergeCanonicalCreators({
    contributors: data.contributors,
    creators: data.creators,
    authors: data.authors,
    editors: data.editors,
    itemType,
  });
  if (!merged || merged.length === 0) {
    return [];
  }
  return merged.map((c, index) => ({
    creatorType: c.creatorType || 'author',
    fieldMode: c.fieldMode !== undefined ? Number(c.fieldMode) : 0,
    firstName: c.firstName || '',
    lastName: c.lastName || '',
    fullName:
      c.fullName ||
      c.name ||
      `${c.firstName || ''} ${c.lastName || ''}`.trim(),
    shortName: c.shortName || '',
    orderIndex: c.orderIndex !== undefined ? c.orderIndex : index,
  }));
}
