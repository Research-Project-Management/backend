import { Injectable, Inject, BadRequestException } from '@nestjs/common';
import { ItemMetadata } from '@/modules/library/ingestion/types/metadata.types';
import {
  CATALOG_FACADE,
  ICatalogFacade,
  CreateItemData,
  CreatorCreditInput,
  ItemDetail,
  splitAuthorString,
  parseCreatorString,
  cleanAbstractText,
  cleanCommentText,
  normalizeTags,
  getEffectiveBaseFieldMap,
  harmonizeZoteroFields,
  resolveCanonicalCreatorRole,
} from '@/modules/library/core';
import {
  IWorkflowStage,
  CommitStageInput,
} from '@/modules/library/ingestion/types/workflow-stage.types';

export type LibraryItemSource =
  | 'WEB_CAPTURE'
  | 'PDF_UPLOAD'
  | 'IDENTIFIER_IMPORT'
  | 'BIBTEX_IMPORT'
  | 'MANUAL'
  | 'CONNECTOR'
  | (string & {});

export interface CommitStageOptions {
  collectionIds?: string[];
  tagIds?: string[];
  userId?: string;
  source?: LibraryItemSource;
  fileId?: string;
  filename?: string;
}

function normalizeAccessedAt(
  value: ItemMetadata['accessedAt'],
): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function extractAuthorString(input: unknown): string {
  if (!input) return '';
  if (typeof input === 'string') return input;
  if (typeof input === 'object' && input !== null) {
    const obj = input as {
      fullName?: unknown;
      name?: unknown;
      firstName?: unknown;
      lastName?: unknown;
    };
    if (typeof obj.fullName === 'string' && obj.fullName.trim()) {
      return obj.fullName.trim();
    }
    if (typeof obj.name === 'string' && obj.name.trim()) {
      return obj.name.trim();
    }
    const parts = [obj.firstName, obj.lastName].filter(
      (p): p is string => typeof p === 'string' && Boolean(p.trim()),
    );
    return parts.join(' ');
  }
  return typeof input === 'number' || typeof input === 'boolean'
    ? String(input)
    : '';
}

function mergeCreators(metadata: ItemMetadata, primaryRole: string = 'author') {
  const initialCreators = metadata.creators || [];
  const creators: CreatorCreditInput[] = [];
  const knownCreators = new Set<string>();

  const append = (
    name: string,
    creatorType: string = primaryRole,
    firstName?: string,
    lastName?: string,
    fieldMode?: number,
    shortName?: string,
  ) => {
    const cleanName = (name || '').trim();
    let finalFirst = firstName?.trim() || '';
    let finalLast = lastName?.trim() || '';
    let finalFull = cleanName;
    let finalFieldMode = fieldMode;

    if (finalFieldMode === 1) {
      const single = finalLast || finalFull || finalFirst;
      if (!single) return;
      finalFirst = '';
      finalLast = single;
      finalFull = single;
    } else if (cleanName.includes(',') || (!finalFirst && !finalLast)) {
      const parsed = parseCreatorString(
        cleanName || `${finalFirst} ${finalLast}`.trim(),
        0,
        creatorType,
      );
      if (parsed.fieldMode === 1) {
        finalFieldMode = 1;
        finalFirst = '';
        finalLast = parsed.lastName || parsed.fullName;
        finalFull = parsed.fullName;
      } else {
        finalFirst = parsed.firstName || finalFirst;
        finalLast = parsed.lastName || finalLast;
        finalFull = parsed.fullName;
      }
    } else if (!finalFull) {
      finalFull = `${finalFirst} ${finalLast}`.trim();
    }

    if (!finalFull && !finalFirst && !finalLast) return;

    const dedupKey =
      finalLast || finalFirst
        ? `${creatorType}:${finalLast.toLowerCase()}:${finalFirst.toLowerCase()}`
        : `${creatorType}:${finalFull.toLowerCase()}`;
    if (knownCreators.has(dedupKey)) return;
    knownCreators.add(dedupKey);

    const displayFull = finalFull || `${finalFirst} ${finalLast}`.trim();
    creators.push({
      name: displayFull,
      fullName: displayFull,
      creatorType,
      firstName: finalFieldMode === 1 ? '' : finalFirst || '',
      lastName: finalLast || '',
      ...(finalFieldMode !== undefined ? { fieldMode: finalFieldMode } : {}),
      ...(shortName ? { shortName } : {}),
    });
  };

  for (const c of initialCreators) {
    const creatorType = resolveCanonicalCreatorRole(
      c.creatorType || primaryRole,
      { itemType: metadata.itemType },
    );
    const cRec = c as unknown as Record<string, unknown>;
    const cFieldMode =
      typeof cRec.fieldMode === 'number' ? cRec.fieldMode : undefined;
    const cShortName =
      typeof cRec.shortName === 'string' && cRec.shortName.trim()
        ? cRec.shortName.trim()
        : undefined;

    if (cFieldMode === 1) {
      const singleName =
        c.lastName || c.fullName || c.name || c.firstName || '';
      append(singleName, creatorType, '', singleName, 1, cShortName);
      continue;
    }

    const rawName = extractAuthorString(c);
    if (rawName) {
      const parts =
        c.firstName || c.lastName ? [rawName] : splitAuthorString(rawName);
      for (const p of parts) {
        append(
          p,
          creatorType,
          c.firstName || undefined,
          c.lastName || undefined,
          cFieldMode,
          cShortName,
        );
      }
    } else if (c.firstName || c.lastName) {
      append(
        '',
        creatorType,
        c.firstName || undefined,
        c.lastName || undefined,
        cFieldMode,
        cShortName,
      );
    }
  }

  const appendStringRoleList = (
    list: unknown[] | undefined,
    role: string,
    checkAnyInitialRole: boolean,
  ) => {
    for (const rawEntry of list || []) {
      const rawStr = extractAuthorString(rawEntry).trim();
      if (!rawStr) continue;
      const lowerStr = rawStr.toLowerCase();
      if (
        checkAnyInitialRole &&
        initialCreators.some(
          (ic) => extractAuthorString(ic).trim().toLowerCase() === lowerStr,
        )
      ) {
        continue;
      }
      if (
        knownCreators.has(`${role}:${lowerStr}:`) ||
        knownCreators.has(`${role}:${lowerStr}`)
      ) {
        continue;
      }
      for (const splitPart of splitAuthorString(rawStr)) {
        append(splitPart, role);
      }
    }
  };

  appendStringRoleList(metadata.authors, primaryRole, true);
  appendStringRoleList(metadata.editors, 'editor', false);

  return creators.length > 0 ? creators : undefined;
}

const CITATION_KEY_STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'on',
  'in',
  'for',
  'of',
  'and',
  'with',
  'via',
  'to',
  'is',
  'are',
]);

function generateBibtexCitationKey(
  metadata: ItemMetadata,
  existingKeys?: Set<string>,
): string | undefined {
  if (metadata.citationKey && metadata.citationKey.trim()) {
    return metadata.citationKey.trim().replace(/\s+/g, '');
  }
  const firstAuthor =
    metadata.authors?.[0] ||
    metadata.creators?.[0]?.lastName ||
    metadata.creators?.[0]?.fullName;
  if (!firstAuthor && !metadata.title) return undefined;

  let authorPart = 'ref';
  if (firstAuthor) {
    const authorTokens = firstAuthor.trim().split(/\s+/);
    authorPart = (authorTokens[authorTokens.length - 1] || firstAuthor)
      .toLowerCase()
      .replace(/[^a-z0-9]/gi, '');
  }
  const yearPart = metadata.year ? String(metadata.year) : '';
  let titlePart = 'paper';
  if (metadata.title) {
    for (const wordItem of metadata.title.trim().split(/\s+/)) {
      const cleanWord = wordItem.replace(/[^a-z0-9]/gi, '').toLowerCase();
      if (cleanWord && !CITATION_KEY_STOP_WORDS.has(cleanWord)) {
        titlePart = cleanWord;
        break;
      }
    }
  }

  const baseKey = `${authorPart || 'ref'}${yearPart}${titlePart || 'paper'}`;
  if (!existingKeys || !existingKeys.has(baseKey)) return baseKey;

  for (const ch of 'abcdefghijklmnopqrstuvwxyz') {
    const candidate = `${baseKey}${ch}`;
    if (!existingKeys.has(candidate)) return candidate;
  }
  let counter = 2;
  while (existingKeys.has(`${baseKey}_${counter}`)) counter++;
  return `${baseKey}_${counter}`;
}

const EXCLUDED_RAW_METADATA_KEYS = new Set([
  'title',
  'abstract',
  'abstractNote',
  'itemType',
  'type',
  'creators',
  'authors',
  'editors',
  'tags',
  'keywords',
  'labels',
  'notes',
  'extraFields',
  'seeAlso',
  'relations',
  'provenance',
  'uploadedById',
  'projectId',
  'collectionId',
  'collectionIds',
  'conferenceName',
]);

/**
 * Converts reconciled provider metadata to the Item persistence contract.
 * This is the sole conversion used by the asynchronous ingestion path.
 */
export function toItemData(
  metadata: ItemMetadata,
  options?: CommitStageOptions,
  primaryRole: string = 'author',
): CreateItemData {
  const rawTags = normalizeTags(
    metadata.tags || metadata.keywords || metadata.labels || [],
  );
  const extraFields: Record<string, unknown> = {
    ...(metadata.extraFields || {}),
    ...(metadata.conferenceName &&
    metadata.conferenceName !==
      (metadata.publicationTitle ??
        metadata.proceedingsTitle ??
        metadata.journal)
      ? { conferenceName: metadata.conferenceName }
      : {}),
  };

  for (const [key, val] of Object.entries(metadata)) {
    if (
      val !== undefined &&
      val !== null &&
      val !== '' &&
      !EXCLUDED_RAW_METADATA_KEYS.has(key) &&
      extraFields[key] === undefined
    ) {
      extraFields[key] = val;
    }
  }

  const effectiveType = metadata.itemType || 'journalArticle';
  const baseMapForType = getEffectiveBaseFieldMap(effectiveType);
  const harmonized = harmonizeZoteroFields(
    { ...metadata, extraFields },
    { itemType: effectiveType, syncExtraFields: true },
  ) as ItemMetadata & Record<string, unknown>;
  const syncedExtraFields =
    harmonized.extraFields && typeof harmonized.extraFields === 'object'
      ? { ...harmonized.extraFields }
      : { ...extraFields };

  const resolvedTitle =
    harmonized.title ||
    (typeof syncedExtraFields.caseName === 'string' &&
      syncedExtraFields.caseName) ||
    (typeof syncedExtraFields.nameOfAct === 'string' &&
      syncedExtraFields.nameOfAct) ||
    (typeof syncedExtraFields.subject === 'string' &&
      syncedExtraFields.subject) ||
    'Untitled Document';

  if (
    baseMapForType.title &&
    resolvedTitle !== 'Untitled Document' &&
    syncedExtraFields[baseMapForType.title] === undefined
  ) {
    syncedExtraFields[baseMapForType.title] = resolvedTitle;
  }

  const resolvedPubDate =
    harmonized.publicationDate ??
    harmonized.date ??
    (typeof syncedExtraFields.filingDate === 'string'
      ? syncedExtraFields.filingDate
      : undefined);

  let resolvedYear = harmonized.year ?? undefined;
  if (!resolvedYear && resolvedPubDate) {
    const match = String(resolvedPubDate).match(/\b(?:1\d{3}|20\d{2})\b/);
    if (match) resolvedYear = parseInt(match[0], 10);
  }

  const mappedTypeKey = baseMapForType.type || baseMapForType.medium;
  const mappedTypeVal =
    mappedTypeKey && typeof harmonized[mappedTypeKey] === 'string'
      ? harmonized[mappedTypeKey]
      : undefined;

  const potentialComment =
    typeof extraFields.comment === 'string'
      ? cleanCommentText(extraFields.comment)
      : undefined;
  delete syncedExtraFields.comment;
  if (metadata.primaryCategory && !syncedExtraFields.primaryCategory) {
    syncedExtraFields.primaryCategory = metadata.primaryCategory;
  }

  const consolidatedNotes: Array<Record<string, unknown> | string> =
    Array.isArray(metadata.notes) ? [...metadata.notes] : [];
  if (potentialComment) {
    const hasExistingCommentNote = consolidatedNotes.some((singleNote) => {
      if (typeof singleNote === 'string') {
        return singleNote.includes(potentialComment);
      }
      return (
        typeof singleNote === 'object' &&
        singleNote !== null &&
        typeof singleNote.content === 'string' &&
        singleNote.content.includes(potentialComment)
      );
    });
    if (!hasExistingCommentNote) {
      consolidatedNotes.push({
        content: `Comment: ${potentialComment}`,
        source: 'arXiv',
      });
    }
  }

  return {
    ...syncedExtraFields,
    title: resolvedTitle,
    itemType: effectiveType,
    type: metadata.type ?? mappedTypeVal,
    doi: harmonized.doi,
    arxivId: harmonized.arxivId,
    primaryCategory: harmonized.primaryCategory,
    pmid: harmonized.pmid,
    pmcid: harmonized.pmcid,
    issn: harmonized.issn,
    isbn: harmonized.isbn,
    year: resolvedYear,
    publicationDate: resolvedPubDate,
    publicationTitle: harmonized.publicationTitle ?? harmonized.journal,
    journal: metadata.journal,
    journalAbbr: harmonized.journalAbbr,
    publisher: harmonized.publisher,
    place: harmonized.place,
    volume: harmonized.volume != null ? String(harmonized.volume) : undefined,
    issue: harmonized.issue != null ? String(harmonized.issue) : undefined,
    section: harmonized.section,
    partNumber: harmonized.partNumber,
    partTitle: harmonized.partTitle,
    pages: harmonized.pages ? String(harmonized.pages) : undefined,
    series: harmonized.series,
    seriesTitle: harmonized.seriesTitle,
    seriesText: harmonized.seriesText,
    seriesNumber: harmonized.seriesNumber,
    abstract: cleanAbstractText(harmonized.abstract) ?? undefined,
    url: harmonized.url,
    citationKey: harmonized.citationKey || generateBibtexCitationKey(metadata),
    shortTitle: metadata.shortTitle,
    creators: mergeCreators(metadata, primaryRole),
    tags: rawTags,
    labels: rawTags,
    keywords: rawTags,
    fileId: options?.fileId || metadata.fileId || undefined,
    filename: options?.filename || metadata.filename || undefined,
    fileUrl:
      metadata.fileUrl ||
      metadata.pdfUrl ||
      metadata.openAccessPdfUrl ||
      undefined,
    openAccessPdfUrl: metadata.openAccessPdfUrl || undefined,
    attachments: metadata.attachments || undefined,
    language: metadata.language,
    rights: harmonized.rights,
    license: harmonized.license,
    archive: metadata.archive,
    archiveLocation: metadata.archiveLocation,
    libraryCatalog: metadata.libraryCatalog,
    callNumber: metadata.callNumber,
    accessedAt: normalizeAccessedAt(
      metadata.accessedAt ??
        (typeof extraFields.accessDate === 'string' ||
        extraFields.accessDate instanceof Date
          ? extraFields.accessDate
          : undefined),
    ),
    citationCount: metadata.citationCount ?? null,
    referenceCount: metadata.referenceCount ?? null,
    extra: metadata.extra,
    extraFields: syncedExtraFields,
    notes: consolidatedNotes,
    collectionId: options?.collectionIds?.[0] || null,
    collectionIds: options?.collectionIds,
    uploadedById: options?.userId || '',
    isRetracted: metadata.isRetracted,
    retractionNature: metadata.retractionNature,
    retractionDetails: metadata.retractionDetails,
    retractionCheckedAt: metadata.retractionCheckedAt,
  };
}

@Injectable()
export class CommitStage implements IWorkflowStage<
  CommitStageInput | { userId?: string; projectId?: string | null } | string,
  ItemDetail
> {
  readonly stageName = 'COMMIT' as const;
  constructor(
    @Inject(CATALOG_FACADE)
    private readonly catalogGateway: ICatalogFacade,
  ) {}

  async execute(
    scopeOrInput:
      | CommitStageInput
      | { userId?: string; projectId?: string | null }
      | string,
    metadata?: ItemMetadata,
    options?: CommitStageOptions,
  ): Promise<ItemDetail> {
    const isStageInput =
      typeof scopeOrInput === 'object' &&
      scopeOrInput !== null &&
      'scopeId' in scopeOrInput &&
      'item' in scopeOrInput;
    const scope = isStageInput ? scopeOrInput.scopeId : scopeOrInput;
    const actualMetadata = isStageInput ? scopeOrInput.item : metadata!;
    const actualOptions = isStageInput ? scopeOrInput.options : options;

    const primaryRole =
      this.catalogGateway?.getPrimaryCreatorType?.(
        actualMetadata.itemType || 'journalArticle',
      ) || 'author';
    const createData = toItemData(actualMetadata, actualOptions, primaryRole);

    let effectiveUserId: string;
    let effectiveProjectId: string | undefined;

    if (typeof scope === 'object' && scope !== null) {
      effectiveUserId = scope.userId || actualOptions?.userId || '';
      effectiveProjectId = scope.projectId || undefined;
    } else {
      const isProject =
        Boolean(scope) && scope !== 'user' && scope !== actualOptions?.userId;
      effectiveUserId =
        actualOptions?.userId || (scope && !isProject ? scope : '');
      effectiveProjectId = isProject ? scope : undefined;
    }

    if (!effectiveUserId) {
      throw new BadRequestException(
        'User context (userId) is mandatory to commit an item into the library catalog.',
      );
    }

    createData.uploadedById = effectiveUserId;
    if (effectiveProjectId) {
      createData.projectId = effectiveProjectId;
    }

    return await this.catalogGateway.createItem(effectiveUserId, createData, {
      projectId: effectiveProjectId,
      source: actualOptions?.source,
    });
  }
}
