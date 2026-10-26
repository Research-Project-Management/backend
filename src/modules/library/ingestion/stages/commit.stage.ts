import { Injectable, Inject, BadRequestException } from '@nestjs/common';
import { ItemMetadata } from '@/modules/library/ingestion/types/metadata.types';
import {
  CATALOG_FACADE,
  ICatalogFacade,
  CreateItemData,
  CreatorCreditInput,
  ItemDetail,
  mergeCanonicalCreators,
  cleanAbstractText,
  cleanCommentText,
  normalizeAcademicTags,
  getEffectiveBaseFieldMap,
  harmonizeZoteroFields,
  generateCitationKey,
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

function mergeCreators(metadata: ItemMetadata, primaryRole: string = 'author') {
  return mergeCanonicalCreators(metadata, primaryRole);
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
  'id',
  'userId',
  'version',
  'deletedAt',
  'createdAt',
  'updatedAt',
  'mergedIntoId',
  'contentHash',
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
  const rawTags = normalizeAcademicTags(
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
    publicationTitle:
      effectiveType === 'preprint'
        ? undefined
        : (harmonized.publicationTitle ?? harmonized.journal),
    journal: effectiveType === 'preprint' ? undefined : metadata.journal,
    journalAbbr:
      effectiveType === 'preprint' ? undefined : harmonized.journalAbbr,
    publisher:
      effectiveType === 'preprint'
        ? (harmonized.repository ?? metadata.repository ?? harmonized.publisher)
        : harmonized.publisher,
    place: harmonized.place,
    volume:
      effectiveType === 'preprint'
        ? undefined
        : harmonized.volume != null
          ? String(harmonized.volume)
          : undefined,
    issue:
      effectiveType === 'preprint'
        ? undefined
        : harmonized.issue != null
          ? String(harmonized.issue)
          : undefined,
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
    citationKey: harmonized.citationKey || generateCitationKey(metadata),
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
    attachments:
      (metadata.attachments as CreateItemData['attachments']) || undefined,
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
    retractionDetails:
      metadata.retractionDetails &&
      typeof metadata.retractionDetails === 'object' &&
      !Array.isArray(metadata.retractionDetails)
        ? (metadata.retractionDetails as Record<string, unknown>)
        : null,
    retractionCheckedAt: metadata.retractionCheckedAt,
  };
}

@Injectable()
export class CommitStage implements IWorkflowStage<
  CommitStageInput,
  ItemDetail
> {
  readonly stageName = 'COMMIT' as const;
  constructor(
    @Inject(CATALOG_FACADE)
    private readonly catalogGateway: ICatalogFacade,
  ) {}

  async execute(input: CommitStageInput): Promise<ItemDetail> {
    const {
      scopeId: scope,
      item: actualMetadata,
      options: actualOptions,
    } = input;

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

    try {
      return await this.catalogGateway.createItem(effectiveUserId, createData, {
        projectId: effectiveProjectId,
        source: actualOptions?.source,
      });
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      const msg = err instanceof Error ? err.message : String(err);
      if (
        code === 'P2002' ||
        msg.includes('Unique constraint failed')
      ) {
        if (this.catalogGateway.findMatchCandidates) {
          const match = await this.catalogGateway.findMatchCandidates(
            { userId: effectiveUserId, projectId: effectiveProjectId },
            {
              doi: createData.doi,
              arxivId: createData.arxivId,
              pmid: createData.pmid,
              isbn: createData.isbn,
              year: createData.year ? Number(createData.year) : undefined,
              titlePrefix: createData.title,
            },
          );
          const matchedId =
            match.exactMatch?.id ??
            match.candidateItems?.find(
              (c) =>
                c.title?.trim().toLowerCase() ===
                  createData.title?.trim().toLowerCase() &&
                (!createData.year ||
                  !c.year ||
                  Number(c.year) === Number(createData.year)),
            )?.id;
          if (matchedId) {
            const existing = await this.catalogGateway.getItem(
              effectiveUserId,
              matchedId,
              effectiveProjectId,
            );
            if (existing) {
              return existing;
            }
          }
        }
      }
      throw err;
    }
  }
}
