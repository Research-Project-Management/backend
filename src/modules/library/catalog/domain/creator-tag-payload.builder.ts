import { Prisma, LinkMode, AttachmentType, AnnotationType, TagType } from '@prisma/client';
import { isUuid } from '@/core';
import {
  normalizeAcademicTags,
  cleanSingleTag,
  buildTipTapDocFromText,
  getPrimaryCreatorRoleForType,
  mergeCanonicalCreators,
  deriveFirstAuthor,
  INTERNAL_SYSTEM_AND_TELEMETRY_KEYS,
  convertAcademicHtmlToMarkdown,
  ItemProvenancePolicy,
  ManualLockMutationInput,
} from '@/modules/library/core';
import {
  ITEM_COLUMN_METADATA_FIELDS,
  FIELD_ALIASES,
  TagInput,
} from '@/modules/library/catalog/types/catalog.types';
import {
  CreateItemData,
  CreatorCreditInput,
} from '@/modules/library/core/types/bibliographic.types';
import { getFileContentPath } from '@/modules/storage/storage.port';
import { ItemsMapper } from './items.mapper';

export { buildTipTapDocFromText, isUuid, deriveFirstAuthor, ITEM_COLUMN_METADATA_FIELDS };
export {
  cleanSingleIdentifier,
  extractExtraKeyValues,
  normalizeItemIdentifiers,
  prepareItemAiMetadataPatch,
} from './identifier-change.helper';
export type { AiMetadataPatchPreparation } from './identifier-change.helper';

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
      const typeVal = 'type' in rt ? (rt as { type?: unknown }).type : undefined;
      const resolvedType =
        typeVal === 1 || typeVal === 'automatic' || typeVal === TagType.automatic
          ? TagType.automatic
          : typeVal === 0 || typeVal === 'manual' || typeVal === TagType.manual
            ? TagType.manual
            : undefined;
      if (resolvedType) {
        tagTypeMap.set(tagName.toLowerCase(), resolvedType);
        const normalized = cleanSingleTag(tagName);
        if (normalized) tagTypeMap.set(normalized.toLowerCase(), resolvedType);
      }
    }
  }
  return tagTypeMap;
}

export function resolveExtraPlainText(
  extraInput?: string | null,
  existingExtra?: string | null,
  patches?: Record<string, unknown> | null,
  demotedExtraLines?: string[] | null,
): string | undefined {
  const hasDemotedLines = Array.isArray(demotedExtraLines) && demotedExtraLines.length > 0;
  const demotedJoined = hasDemotedLines ? demotedExtraLines!.join('\n').trim() : '';
  const isDemotedOnlyExtra =
    hasDemotedLines &&
    typeof extraInput === 'string' &&
    extraInput.trim() === demotedJoined &&
    Boolean(existingExtra && existingExtra.trim());

  const rawCandidate = isDemotedOnlyExtra
    ? existingExtra!
    : (extraInput !== undefined && extraInput !== null ? extraInput : existingExtra) ?? '';
  const cleanRaw = typeof rawCandidate === 'string' ? rawCandidate.trim() : '';

  const normalizeExtraKey = (k: string) => k.trim().toLowerCase().replace(/[\s_-]+/g, '');
  const patchLookup = new Map<string, { originalKey: string; val: unknown }>();
  for (const [pKey, pVal] of Object.entries(patches || {})) {
    if (!pKey.startsWith('__') && pVal !== undefined) {
      patchLookup.set(normalizeExtraKey(pKey), { originalKey: pKey, val: pVal });
    }
  }
  if (hasDemotedLines) {
    for (const dLine of demotedExtraLines!) {
      const cIdx = dLine.indexOf(':');
      if (cIdx !== -1) {
        const k = dLine.slice(0, cIdx).trim();
        const v = dLine.slice(cIdx + 1).trim();
        const normK = normalizeExtraKey(k);
        if (normK && !patchLookup.has(normK)) patchLookup.set(normK, { originalKey: k, val: v });
      }
    }
  }

  if (patchLookup.size === 0) return cleanRaw || undefined;
  const matchedKeys = new Set<string>();
  const updatedLines: string[] = [];
  for (const line of cleanRaw.split('\n')) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) {
      if (line.trim()) updatedLines.push(line);
      continue;
    }
    const linePrefix = line.slice(0, colonIndex).trim();
    const lineKey = normalizeExtraKey(linePrefix);
    if (patchLookup.has(lineKey)) {
      matchedKeys.add(lineKey);
      const { val } = patchLookup.get(lineKey)!;
      if ((typeof val === 'string' && val !== '') || typeof val === 'number' || typeof val === 'boolean') {
        updatedLines.push(`${linePrefix}: ${String(val)}`);
      }
    } else {
      updatedLines.push(line);
    }
  }

  if (hasDemotedLines) {
    for (const dLine of demotedExtraLines!) {
      const cIdx = dLine.indexOf(':');
      if (cIdx !== -1) {
        const k = normalizeExtraKey(dLine.slice(0, cIdx));
        if (!matchedKeys.has(k)) {
          matchedKeys.add(k);
          updatedLines.push(dLine);
        }
      } else if (dLine.trim() && !updatedLines.includes(dLine.trim())) {
        updatedLines.push(dLine.trim());
      }
    }
  }
  return updatedLines.join('\n').trim() || undefined;
}

const IGNORED_SYSTEM_KEYS = new Set([
  ...INTERNAL_SYSTEM_AND_TELEMETRY_KEYS,
  'id', 'userId', 'projectId', 'createdById', 'uploadedById',
  'createdAt', 'updatedAt', 'deletedAt', 'version', '_version',
  'expectedVersion', 'isDeleted', 'silent', 'creators', 'authors', 'author',
  'contributors', 'editors', 'tags', 'labels', 'itemTags', 'zoteroTags',
  'keywords', 'keywordsList', 'attachments', 'primaryFile', 'filename',
  'notes', 'notesList', 'collectionId', 'collectionIds', 'collections',
  'collectionItems', 'userStates', 'states', 'readStatus', 'rating',
  'lastReadAt', 'isStarred', 'metadata', 'extraFields',
  'fileId', 'size', 'mimeType', 'hasFile', 'attachmentCount', 'noteCount',
  'firstAuthor', 'outgoingRel', 'incomingRel', 'relations', 'seeAlso',
  'identifiers', 'ingestionRuns', 'itemMetadata', 'publications',
  'crossrefEnriched', 'publicationConfirmedAt', 'sourceProvider',
  'source', 'sources', 'originProvider', 'canonicalId', 'canonicalUrl',
  'resolvedAt', 'warnings', 'disambiguationWarning', 'rejectedCitedDoi',
  'promptUploadPdf', 'lockedFields', '__isSystemUpdate', '__updateSource',
]);

export type RecordManualLockInput = ManualLockMutationInput;

export function applyManualEditProvenanceLocks(input: RecordManualLockInput): void {
  const hasExplicitLocks =
    Array.isArray(input.dataRecord.lockedFields) ||
    input.dataRecord.lockedFields === null ||
    Array.isArray(input.dataExtra?.lockedFields) ||
    input.dataExtra?.lockedFields === null;
  const effectiveExistingMeta = hasExplicitLocks
    ? {
        ...input.existingMeta,
        lockedFields: Array.isArray(input.updatedMetadata.lockedFields)
          ? input.updatedMetadata.lockedFields
          : [],
        fieldProvenance: input.updatedMetadata.fieldProvenance ?? input.existingMeta.fieldProvenance,
      }
    : input.existingMeta;
  ItemProvenancePolicy.applyManualEditLocks({ ...input, existingMeta: effectiveExistingMeta });
  if (hasExplicitLocks) {
    const rawExplicit =
      Array.isArray(input.dataRecord.lockedFields) || input.dataRecord.lockedFields === null
        ? input.dataRecord.lockedFields
        : input.dataExtra?.lockedFields;
    const explicitSet = new Set(
      Array.isArray(rawExplicit)
        ? (rawExplicit as unknown[]).filter((f): f is string => typeof f === 'string' && f.trim().length > 0)
        : [],
    );
    input.updatedMetadata.lockedFields = Array.from(explicitSet);
    if (input.updatedMetadata.fieldProvenance && typeof input.updatedMetadata.fieldProvenance === 'object') {
      const prov = { ...(input.updatedMetadata.fieldProvenance as Record<string, unknown>) };
      for (const [k, v] of Object.entries(prov)) {
        if (!explicitSet.has(k) && v && typeof v === 'object') {
          const rec = v as Record<string, unknown>;
          if (rec.isUserOverride === true || rec.source === 'UserOverride') delete prov[k];
        }
      }
      input.updatedMetadata.fieldProvenance = prov;
    }
  }
}

const NON_COLUMN_SYMMETRIC_ALIASES: Readonly<Record<string, string>> = {
  numPages: 'numberOfPages',
  numberOfPages: 'numPages',
  authority: 'issuingAuthority',
  issuingAuthority: 'authority',
};

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
        const pairedKey = NON_COLUMN_SYMMETRIC_ALIASES[key];
        if (pairedKey && source[pairedKey] === undefined) result[pairedKey] = value;
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
  const existingNotesArr = (Array.isArray(existingNotesList) ? existingNotesList : []) as Array<{ contentMd?: string }>;
  const seen = new Set(
    existingNotesArr.map((n) => (typeof n.contentMd === 'string' ? n.contentMd.trim() : '')).filter(Boolean),
  );
  return notes
    .map((note) => {
      const noteObj = typeof note === 'object' && note !== null ? (note as Record<string, unknown>) : null;
      const rawContent = typeof note === 'string' ? note : (noteObj?.content ?? noteObj?.contentMd ?? noteObj?.note ?? '');
      const rawStr = typeof rawContent === 'string' ? rawContent : '';
      const contentMd = /<\/?[a-z][\s\S]*>/i.test(rawStr) ? convertHtmlToMarkdown(rawStr) : rawStr.trim();
      if (!contentMd || seen.has(contentMd)) return null;
      seen.add(contentMd);
      const sourceName = typeof noteObj?.source === 'string' ? noteObj.source.trim() : '';
      const isComment = contentMd.toLowerCase().startsWith('comment:');
      let noteTitle = typeof noteObj?.title === 'string' ? noteObj.title.trim() : '';
      if (!noteTitle) {
        const firstLine =
          contentMd
            .split(/\r?\n/)
            .find((l) => l.trim().length > 0)
            ?.replace(/^#+\s*/, '')
            .replace(/^>\s*/, '')
            .trim() || '';
        if (firstLine) {
          noteTitle = firstLine.length <= 80 ? firstLine : `${firstLine.slice(0, 77)}...`;
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
        ? (noteObj.tags as unknown[]).filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
        : [];
      const baseTags = normalizeAcademicTags([
        'imported',
        ...(sourceName ? [sourceName] : []),
        ...(isComment ? ['comment'] : []),
      ]);
      const mergedTags = Array.from(new Set([...baseTags, ...customTags.map((t) => t.trim())]));
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
  fallbackData?: { filename?: string; fileUrl?: string; size?: number; mimeType?: string },
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
      const rawFilename = typeof att.filename === 'string' && att.filename.trim() ? att.filename.trim() : '';
      const filename =
        rawFilename || (title ? (title.toLowerCase().endsWith('.pdf') ? title : `${title}.pdf`) : 'document.pdf');
      const mimeType =
        (typeof att.mimeType === 'string' && att.mimeType.trim()) ||
        (typeof att.contentType === 'string' && att.contentType.trim()) ||
        'application/pdf';
      const size =
        typeof att.size === 'number' ? att.size : typeof att.fileSize === 'number' ? att.fileSize : 0;
      const fileUrl =
        typeof att.url === 'string' && att.url.trim()
          ? att.url.trim()
          : resolvedFileId ? getFileContentPath(resolvedFileId) : '';
      const isPdf = mimeType === 'application/pdf' || filename.toLowerCase().endsWith('.pdf');
      let attachmentType: AttachmentType | undefined =
        (att.attachmentType as AttachmentType) || (att.type as AttachmentType | undefined);
      if (!attachmentType) {
        if (!hasPrimaryPdf && isPdf) {
          attachmentType = AttachmentType.primary_pdf;
          hasPrimaryPdf = true;
        } else if (mimeType.includes('html') || filename.toLowerCase().endsWith('.html')) {
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
            ? attachmentType === AttachmentType.snapshot ? LinkMode.imported_url : LinkMode.linked_url
            : LinkMode.imported_file);
      const metadata: Record<string, unknown> = {
        ...(typeof att.metadata === 'object' && att.metadata !== null ? (att.metadata as Record<string, unknown>) : {}),
        ...(title ? { title } : {}),
        ...(att.accessDate ? { accessDate: att.accessDate } : {}),
      };
      const annotationsToCreate =
        Array.isArray(att.annotations) && att.annotations.length > 0
          ? att.annotations
              .filter((ann: unknown) => ann && typeof ann === 'object' && !(ann as Record<string, unknown>).deletedAt)
              .map((rawAnn: unknown) => {
                const ann = rawAnn as Record<string, unknown>;
                return {
                  type: (ann.type as AnnotationType) || AnnotationType.highlight,
                  color: (ann.color as string) || '#ffd400',
                  pageIndex: typeof ann.pageIndex === 'number' ? ann.pageIndex : 0,
                  pageLabel: typeof ann.pageLabel === 'string' ? ann.pageLabel : '',
                  annotationSortIndex: typeof ann.annotationSortIndex === 'string' ? ann.annotationSortIndex : '',
                  rectCoords: ann.rectCoords !== undefined ? (ann.rectCoords as Prisma.InputJsonValue) : Prisma.JsonNull,
                  quoteText: typeof ann.quoteText === 'string' ? ann.quoteText : null,
                  comment: typeof ann.comment === 'string' ? ann.comment : '',
                  tags: Array.isArray(ann.tags) ? (ann.tags as string[]).filter((t): t is string => typeof t === 'string') : [],
                  authorId:
                    typeof ann.authorId === 'string' && isUuid(ann.authorId)
                      ? ann.authorId
                      : userId && isUuid(userId) ? userId : '00000000-0000-0000-0000-000000000000',
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
        metadata: Object.keys(metadata).length > 0 ? (metadata as Prisma.InputJsonValue) : undefined,
        ...(annotationsToCreate.length > 0 ? { annotations: { create: annotationsToCreate } } : {}),
        ...(fileUrl || resolvedFileId
          ? {
              revisions: {
                create: [{ revisionNumber: 1, url: fileUrl, sizeBytes: size, fileHash: (att.fileHash as string) || null }],
              },
            }
          : {}),
      });
    }
  }
  if (
    result.length === 0 &&
    (fallbackFileId || (fallbackData?.fileUrl && !/^https?:\/\//i.test(fallbackData.fileUrl)))
  ) {
    const fileUrl = fallbackData?.fileUrl || (fallbackFileId ? getFileContentPath(fallbackFileId) : '');
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
      revisions: { create: [{ revisionNumber: 1, url: fileUrl, sizeBytes: size, fileHash: null }] },
    });
  }
  return result;
}

export function prepareContributorsToCreate(
  data: {
    contributors?: CreatorCreditInput[];
    creators?: CreatorCreditInput[];
    authors?: string[];
    author?: string;
    editors?: string[];
  },
  itemType?: string,
  existingContributors?: Array<Record<string, unknown> | CreatorCreditInput> | null,
): Array<{
  creatorType: string;
  fieldMode?: number;
  firstName: string;
  lastName: string;
  fullName: string;
  shortName?: string;
  orderIndex: number;
}> | null {
  const effectiveAuthors =
    data.authors !== undefined
      ? data.authors
      : typeof data.author === 'string' && data.author.trim() ? [data.author.trim()] : undefined;

  if (
    data.contributors === undefined &&
    data.creators === undefined &&
    effectiveAuthors === undefined &&
    data.editors === undefined
  ) {
    return null;
  }

  const primaryRole = getPrimaryCreatorRoleForType(itemType);
  let baseContributors = data.contributors;
  const baseCreators = data.creators;
  const formatCreatorList = (list: CreatorCreditInput[]) =>
    list.map((c, index) => ({
      creatorType: c.creatorType || primaryRole,
      fieldMode: c.fieldMode !== undefined ? Number(c.fieldMode) : 0,
      firstName: c.firstName || '',
      lastName: c.lastName || '',
      fullName: c.fullName || c.name || `${c.firstName || ''} ${c.lastName || ''}`.trim(),
      shortName: c.shortName || '',
      orderIndex: c.orderIndex !== undefined ? c.orderIndex : index,
    }));

  if (
    baseContributors === undefined &&
    baseCreators === undefined &&
    Array.isArray(existingContributors) &&
    existingContributors.length > 0
  ) {
    const primaryRoleLower = primaryRole.toLowerCase();
    const getRoleLower = (c: Record<string, unknown> | CreatorCreditInput) =>
      String((c as Record<string, unknown>).creatorType || (c as Record<string, unknown>).role || 'author')
        .trim()
        .toLowerCase();

    if (data.editors !== undefined && effectiveAuthors === undefined) {
      baseContributors = existingContributors.filter((c) => getRoleLower(c) !== 'editor') as CreatorCreditInput[];
    } else if (effectiveAuthors !== undefined && data.editors === undefined) {
      const preservedNonPrimary = existingContributors.filter((c) => {
        const r = getRoleLower(c);
        return r !== 'author' && r !== primaryRoleLower;
      }) as CreatorCreditInput[];
      if (preservedNonPrimary.length > 0) {
        const mergedAuthors = mergeCanonicalCreators({ authors: effectiveAuthors, itemType }, primaryRole) || [];
        const mergedAll =
          mergeCanonicalCreators(
            { contributors: [...mergedAuthors, ...preservedNonPrimary], itemType },
            primaryRole,
          ) || [];
        return formatCreatorList(mergedAll.map((c, idx) => ({ ...c, orderIndex: idx })));
      }
    }
  }

  const merged = mergeCanonicalCreators(
    {
      contributors: baseContributors,
      creators: baseCreators,
      authors: effectiveAuthors,
      editors: data.editors,
      itemType,
    },
    primaryRole,
  );
  return !merged || merged.length === 0 ? [] : formatCreatorList(merged);
}

export interface ImportSourceItem {
  title: string;
  year?: number | null; doi?: string | null; abstract?: string | null; itemType?: string | null;
  publicationTitle?: string | null; publicationDate?: string | null; publisher?: string | null;
  place?: string | null; volume?: string | null; issue?: string | null; section?: string | null;
  partNumber?: string | null; partTitle?: string | null; pages?: string | null; series?: string | null;
  seriesTitle?: string | null; seriesText?: string | null; seriesNumber?: string | null; edition?: string | null;
  accessedAt?: string | null; isRetracted?: boolean | null; retractionNature?: string | null;
  retractionDetails?: string | null; retractionCheckedAt?: string | Date | null;
  fieldProvenance?: Record<string, unknown> | null; lockedFields?: string[] | null;
  issn?: string | null; isbn?: string | null; pmid?: string | null; pmcid?: string | null;
  url?: string | null; language?: string | null; journalAbbr?: string | null; shortTitle?: string | null;
  rights?: string | null; license?: string | null; citationKey?: string | null;
  libraryCatalog?: string | null; archive?: string | null; archiveLocation?: string | null;
  callNumber?: string | null; extra?: string | null; arxivId?: string | null;
  citationCount?: number | null; referenceCount?: number | null; openAccessPdfUrl?: string | null;
  fileId?: string | null; fileUrl?: string | null; filename?: string | null;
  mimeType?: string | null; size?: number | bigint | null; fileHash?: string | null;
  attachments?: Array<{
    fileId?: string | null; url?: string | null; filename?: string | null; name?: string | null;
    mimeType?: string | null; size?: number | bigint | null; fileHash?: string | null;
  }>;
  itemTags?: Array<{ tag?: { name?: string } }>;
  notesList?: Array<{ title?: string; contentMd?: string; tags?: string[] }>;
  contributors?: Array<{
    creatorType?: string; firstName?: string | null; lastName?: string | null; fullName?: string; orderIndex?: number;
  }>;
  identifiers?: Array<{ type: string; value: string; canonicalUri?: string | null }>;
  [key: string]: unknown;
}

const IMPORT_UNPACKED_FALLBACK_KEYS = [
  'publisher', 'place', 'volume', 'issue', 'section', 'partNumber', 'partTitle', 'pages',
  'series', 'seriesTitle', 'seriesText', 'seriesNumber', 'edition', 'accessedAt',
  'isRetracted', 'retractionNature', 'retractionDetails', 'retractionCheckedAt',
  'fieldProvenance', 'lockedFields', 'issn', 'isbn', 'pmid', 'pmcid', 'arxivId',
  'language', 'shortTitle', 'rights', 'license', 'libraryCatalog', 'archive',
  'archiveLocation', 'callNumber', 'extra', 'citationCount', 'referenceCount', 'openAccessPdfUrl',
] as const;

export function buildImportItemPayload(rawSource: ImportSourceItem, userId: string): CreateItemData {
  const unpacked = ItemsMapper.toDomain(rawSource) as Record<string, unknown>;
  const source: ImportSourceItem = {
    ...unpacked,
    ...rawSource,
    publicationDate:
      rawSource.publicationDate ??
      (unpacked.publicationDate as string | null | undefined) ??
      (unpacked.date as string | null | undefined),
    journalAbbr:
      rawSource.journalAbbr ??
      (unpacked.journalAbbreviation as string | null | undefined) ??
      (unpacked.journalAbbr as string | null | undefined),
  };
  for (const k of IMPORT_UNPACKED_FALLBACK_KEYS) {
    if (rawSource[k] === undefined || rawSource[k] === null) {
      (source as Record<string, unknown>)[k] = rawSource[k] ?? unpacked[k];
    }
  }

  const primaryAttachment = rawSource.attachments?.[0];
  const resolvedFileId = primaryAttachment?.fileId
    ? String(primaryAttachment.fileId)
    : source.fileId ? String(source.fileId) : undefined;
  const resolvedFileUrl = primaryAttachment?.url || source.fileUrl || undefined;
  const resolvedFilename = primaryAttachment?.filename || primaryAttachment?.name || source.filename || undefined;
  const resolvedMimeType = primaryAttachment?.mimeType || source.mimeType || undefined;
  const rawSize = primaryAttachment?.size ?? source.size;
  const resolvedSize = rawSize !== undefined && rawSize !== null ? Number(rawSize) : undefined;
  const resolvedFileHash = primaryAttachment?.fileHash || source.fileHash || undefined;

  const clonedAttachments = (source.attachments || []).map((att) => {
    const attRec = att as Record<string, unknown>;
    return {
      title: att.name || att.filename || 'document.pdf',
      filename: att.filename || att.name || 'document.pdf',
      url: att.url || (att.fileId ? `/api/files/${att.fileId}/content` : ''),
      fileId: att.fileId ? String(att.fileId) : null,
      fileHash: att.fileHash || '',
      mimeType: att.mimeType || 'application/pdf',
      size: att.size !== undefined && att.size !== null ? Number(att.size) : 0,
      linkMode: attRec.linkMode as string | undefined,
      attachmentType: attRec.attachmentType as string | undefined,
      metadata: attRec.metadata as Record<string, unknown> | undefined,
      annotations: Array.isArray(attRec.annotations)
        ? (attRec.annotations as Array<Record<string, unknown>>)
            .filter((ann) => ann && !ann.deletedAt)
            .map((ann) => ({
              type: ann.type || 'highlight',
              color: ann.color || '#ffd400',
              pageIndex: typeof ann.pageIndex === 'number' ? ann.pageIndex : 0,
              pageLabel: typeof ann.pageLabel === 'string' ? ann.pageLabel : '',
              annotationSortIndex: typeof ann.annotationSortIndex === 'string' ? ann.annotationSortIndex : '',
              rectCoords: ann.rectCoords ?? null,
              quoteText: typeof ann.quoteText === 'string' ? ann.quoteText : null,
              comment: typeof ann.comment === 'string' ? ann.comment : '',
              tags: Array.isArray(ann.tags) ? (ann.tags as string[]) : [],
              authorId: userId,
            }))
        : [],
    };
  });

  const payload: CreateItemData = {
    title: source.title,
    attachmentCount: clonedAttachments.length,
    attachments: clonedAttachments,
    uploadedById: userId,
    year: source.year ?? undefined,
    doi: source.doi ?? undefined,
    abstract: source.abstract ?? undefined,
    itemType: source.itemType || 'journalArticle',
    publicationTitle: source.publicationTitle ?? undefined,
    publicationDate: source.publicationDate ?? undefined,
    url: source.url ?? undefined,
    citationKey: source.citationKey ?? undefined,
    journalAbbr: source.journalAbbr ?? undefined,
    accessedAt: source.accessedAt ? new Date(source.accessedAt) : undefined,
    extraFields: (unpacked.extraFields as Record<string, unknown> | undefined) ?? undefined,
    fileId: resolvedFileId,
    fileUrl: resolvedFileUrl,
    filename: resolvedFilename,
    mimeType: resolvedMimeType,
    size: resolvedSize,
    fileHash: resolvedFileHash,
    tags:
      source.itemTags
        ?.map((itemTag: { tag?: { name?: string } }) => itemTag.tag?.name)
        .filter((tagName: unknown): tagName is string => Boolean(tagName)) || [],
    notes:
      source.notesList?.map((note: { title?: string; contentMd?: string; tags?: string[] }) => ({
        title: note.title,
        contentMd: note.contentMd,
        content: note.contentMd,
        tags: note.tags || [],
      })) || [],
    creators: mergeCanonicalCreators({
      contributors: source.contributors,
      itemType: source.itemType || 'journalArticle',
    }),
    identifiers: source.identifiers?.map((identifier) => ({
      type: identifier.type,
      value: identifier.value,
      canonicalUri: identifier.canonicalUri ?? undefined,
    })),
  };
  for (const k of IMPORT_UNPACKED_FALLBACK_KEYS) {
    if (k === 'accessedAt') continue;
    (payload as Record<string, unknown>)[k] = source[k] ?? undefined;
  }
  return payload;
}
