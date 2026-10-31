import {
  Injectable,
  Inject,
  Optional,
  BadRequestException,
} from '@nestjs/common';
import { ItemMetadata } from '@/modules/library/ingestion/types/metadata.types';
import {
  CATALOG_FACADE,
  ICatalogFacade,
  CreateItemData,
  CreatorCreditInput,
  ItemDetail,
  INTERNAL_SYSTEM_AND_TELEMETRY_KEYS,
  mergeCanonicalCreators,
  cleanAbstractText,
  cleanCommentText,
  normalizeAcademicTags,
  getEffectiveBaseFieldMap,
  harmonizeZoteroFields,
  generateCitationKey,
  isPlaceholderItemTitle,
  CANONICAL_BIBLIOGRAPHIC_COLUMN_AND_ALIAS_KEYS,
} from '@/modules/library/core';
import { calculateTitleSimilarity } from '@/modules/library/ingestion/domain/deduplication.domain';
import {
  IWorkflowStage,
  CommitStageInput,
} from '@/modules/library/ingestion/types/ingestion.types';
import { buildEnrichmentPatch } from '@/modules/library/ingestion/domain/enrichment-patch.builder';

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
  skipPreMatch?: boolean;
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
  ...INTERNAL_SYSTEM_AND_TELEMETRY_KEYS,
  ...CANONICAL_BIBLIOGRAPHIC_COLUMN_AND_ALIAS_KEYS,
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
  'fileId',
  'filename',
  'fileUrl',
  'pdfUrl',
  'openAccessPdfUrl',
  'attachments',
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
        ? (harmonized.repository ??
          harmonized.publicationTitle ??
          harmonized.journal)
        : (harmonized.publicationTitle ?? harmonized.journal),
    journal: effectiveType === 'preprint' ? undefined : metadata.journal,
    journalAbbr:
      effectiveType === 'preprint' ? undefined : harmonized.journalAbbr,
    publisher:
      effectiveType === 'preprint'
        ? (harmonized.repository ??
          harmonized.publisher ??
          harmonized.publicationTitle)
        : harmonized.publisher,
    repository:
      effectiveType === 'preprint'
        ? (harmonized.repository ??
          harmonized.publisher ??
          harmonized.publicationTitle)
        : harmonized.repository,
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
    shortTitle:
      metadata.shortTitle ??
      (syncedExtraFields.shortTitle as string | undefined),
    creators: mergeCreators(metadata, primaryRole),
    tags: rawTags,
    labels: rawTags,
    keywords: rawTags,
    fileId: options?.fileId || undefined,
    filename: options?.filename || metadata.filename || undefined,
    fileUrl:
      metadata.fileUrl ||
      metadata.pdfUrl ||
      metadata.openAccessPdfUrl ||
      undefined,
    openAccessPdfUrl: metadata.openAccessPdfUrl || undefined,
    attachments: metadata.attachments || undefined,
    language:
      metadata.language ?? (syncedExtraFields.language as string | undefined),
    rights:
      harmonized.rights ?? (syncedExtraFields.rights as string | undefined),
    license:
      harmonized.license ?? (syncedExtraFields.license as string | undefined),
    archive:
      metadata.archive ?? (syncedExtraFields.archive as string | undefined),
    archiveLocation:
      metadata.archiveLocation ??
      (syncedExtraFields.archiveLocation as string | undefined),
    libraryCatalog:
      metadata.libraryCatalog ??
      (syncedExtraFields.libraryCatalog as string | undefined),
    callNumber:
      metadata.callNumber ??
      (syncedExtraFields.callNumber as string | undefined),
    accessedAt: normalizeAccessedAt(
      metadata.accessedAt ??
        (typeof extraFields.accessDate === 'string' ||
        extraFields.accessDate instanceof Date
          ? extraFields.accessDate
          : undefined),
    ),
    citationCount: metadata.citationCount ?? null,
    referenceCount: metadata.referenceCount ?? null,
    extra: metadata.extra ?? (syncedExtraFields.extra as string | undefined),
    extraFields: (() => {
      const cleaned = { ...syncedExtraFields };
      for (const colKey of CANONICAL_BIBLIOGRAPHIC_COLUMN_AND_ALIAS_KEYS) {
        delete cleaned[colKey];
      }
      return cleaned;
    })(),
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
        ? metadata.retractionDetails
        : null,
    retractionCheckedAt: metadata.retractionCheckedAt,
  };
}

export interface CommitMatchedSideEffectsPort {
  saveItemMetadataSnapshot?: (
    itemId: string,
    payload: Record<string, unknown>,
  ) => Promise<unknown>;
  syncRelationsForCommittedItem?: (
    itemId: string,
    candidateMeta: Record<string, unknown>,
    scopeId?: string | { userId?: string; projectId?: string },
  ) => Promise<unknown>;
  materializeNotes?: (
    userId: string,
    projectId: string | undefined,
    itemId: string,
    notes?: unknown[],
    createdItem?: Record<string, unknown> | null,
  ) => Promise<unknown>;
  assignItemToCollection?: (
    userId: string,
    collectionId: string,
    itemId: string,
    projectId?: string,
  ) => Promise<unknown>;
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
    @Optional()
    private readonly sideEffects?: CommitMatchedSideEffectsPort,
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

    if (
      !actualOptions?.skipPreMatch &&
      (createData.doi || createData.arxivId) &&
      this.catalogGateway?.findMatchCandidates
    ) {
      try {
        const preMatch = await this.catalogGateway.findMatchCandidates(
          { userId: effectiveUserId, projectId: effectiveProjectId },
          {
            doi: createData.doi,
            arxivId: createData.arxivId,
          },
        );
        const existingId = preMatch?.exactMatch?.id;
        const existingTitle = preMatch?.exactMatch?.title?.trim();
        const proposedTitle = createData.title?.trim();
        const isGeneric = (t?: string) =>
          !t || t.length <= 5 || isPlaceholderItemTitle(t);
        const titlesConflict =
          Boolean(proposedTitle) &&
          Boolean(existingTitle) &&
          !isGeneric(proposedTitle) &&
          !isGeneric(existingTitle) &&
          calculateTitleSimilarity(proposedTitle ?? '', existingTitle ?? '') <
            0.5;
        if (existingId && !titlesConflict) {
          const existingItem = await this.catalogGateway.getItem(
            effectiveUserId,
            existingId,
            effectiveProjectId,
          );
          if (existingItem) {
            return await this.enrichMatchedExistingItem(
              effectiveUserId,
              effectiveProjectId,
              existingItem,
              createData,
            );
          }
        }
      } catch {
        // Fall through to standard creation
      }
    }

    try {
      return await this.catalogGateway.createItem(effectiveUserId, createData, {
        projectId: effectiveProjectId,
        source: actualOptions?.source,
      });
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      const msg = err instanceof Error ? err.message : String(err);
      if (code === 'P2002' || msg.includes('Unique constraint failed')) {
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
              return await this.enrichMatchedExistingItem(
                effectiveUserId,
                effectiveProjectId,
                existing,
                createData,
              );
            }
          }
        }
      }
      throw err;
    }
  }

  private async enrichMatchedExistingItem(
    userId: string,
    projectId: string | undefined,
    existingItem: ItemDetail,
    createData: CreateItemData,
  ): Promise<ItemDetail> {
    const markPreExisting = (target: ItemDetail): ItemDetail => {
      if (target && typeof target === 'object') {
        Object.defineProperty(target, '__wasPreExistingMatch', {
          value: true,
          enumerable: false,
          configurable: true,
        });
      }
      return target;
    };

    let resultItem = existingItem;
    if (this.catalogGateway?.updateItem) {
      try {
        const patch = buildEnrichmentPatch(existingItem, createData);
        if (Object.keys(patch).length > 0) {
          const updated = await this.catalogGateway.updateItem(
            userId,
            existingItem.id,
            patch,
            { projectId },
          );
          if (updated) resultItem = updated;
        }
      } catch {
        // Non-critical additive enrichment on pre-match or P2002 race
      }
    }

    const createDataRec = createData as unknown as Record<string, unknown>;
    const existingRec = existingItem as unknown as Record<string, unknown>;
    try {
      await this.sideEffects?.saveItemMetadataSnapshot?.(
        existingItem.id,
        createDataRec,
      );
      await this.sideEffects?.syncRelationsForCommittedItem?.(
        existingItem.id,
        createDataRec,
        { userId, projectId },
      );
      if (Array.isArray(createData.notes) && createData.notes.length > 0) {
        if (this.sideEffects?.materializeNotes) {
          await this.sideEffects.materializeNotes(
            userId,
            projectId,
            existingItem.id,
            createData.notes,
            existingRec,
          );
        } else if (this.catalogGateway?.createNote) {
          const existingNotes = Array.isArray(existingRec.notesList)
            ? existingRec.notesList
            : Array.isArray(existingRec.notes)
              ? existingRec.notes
              : [];
          const seen = new Set<string>(
            existingNotes
              .map((n: unknown) =>
                typeof n === 'string'
                  ? n.trim().toLowerCase()
                  : typeof n === 'object' && n !== null
                    ? String(
                        (n as Record<string, unknown>).contentMd ??
                          (n as Record<string, unknown>).content ??
                          '',
                      )
                        .trim()
                        .toLowerCase()
                    : '',
              )
              .filter(Boolean),
          );
          for (const rawNote of createData.notes) {
            const contentMd =
              typeof rawNote === 'string'
                ? rawNote.trim()
                : typeof rawNote === 'object' && rawNote !== null
                  ? String(
                      (rawNote as Record<string, unknown>).content ?? '',
                    ).trim()
                  : '';
            if (!contentMd || seen.has(contentMd.toLowerCase())) continue;
            seen.add(contentMd.toLowerCase());
            await this.catalogGateway.createNote(userId, {
              itemId: existingItem.id,
              contentMd,
              title: 'Imported Note',
              projectId,
              createdById: userId,
            });
          }
        }
      }
      if (
        Array.isArray(createData.collectionIds) &&
        createData.collectionIds.length > 0 &&
        this.catalogGateway?.assignItemsToCollection
      ) {
        for (const collectionId of createData.collectionIds) {
          if (!collectionId) continue;
          await this.catalogGateway.assignItemsToCollection(
            userId,
            collectionId,
            [existingItem.id],
            projectId,
          );
        }
      }
    } catch {
      // Non-critical side-effects on matched item enrichment
    }

    return markPreExisting(resultItem);
  }
}
