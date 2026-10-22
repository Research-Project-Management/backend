import { disambiguateCitationKey } from './citation-key.engine';
import { Prisma, TagType } from '@prisma/client';
import { PrismaService } from '@/core';
import { generateCitationKey } from '@/modules/library/core/domain/identifier.domain';
import {
  sanitizeItemTitle,
  cleanAbstractText,
  getEffectiveBaseFieldMap,
  harmonizeZoteroFields,
} from '@/modules/library/core';
import {
  ITEM_COLUMN_METADATA_FIELDS,
  FIELD_ALIASES,
  BASE_FIELD_MAPPINGS,
  parseAccessDate,
} from '@/modules/library/catalog/types/items.constants';
import {
  CreateItemData,
  UpdateItemData,
  ItemDetail,
} from '@/modules/library/core/types/bibliographic.types';
import { TagInput } from '@/modules/library/catalog/types/tags.types';
import {
  isUuid,
  cleanSingleIdentifier,
  extractExtraKeyValues,
  normalizeItemIdentifiers,
  resolveExtraPlainText,
  extractNonColumnExtraFields,
  convertHtmlToMarkdown,
  buildTipTapDocFromText,
  prepareNotesToCreate,
  prepareAttachmentsToCreate,
  resolveOrCreateTags,
  syncTagsForCatalogItem,
  deriveFirstAuthor,
  prepareContributorsToCreate,
  buildTagTypeMap,
  ResolvedTag,
} from './creator-tag-payload.builder';

export * from './creator-tag-payload.builder';
export type { ResolvedTag };

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

export const ALL_MAPPED_PUB_TITLE_KEYS: ReadonlyArray<string> = Array.from(
  new Set(Object.values(BASE_FIELD_MAPPINGS).map((m) => m.publicationTitle).filter(Boolean)),
);

export const ALL_MAPPED_PUBLISHER_KEYS: ReadonlyArray<string> = Array.from(
  new Set(Object.values(BASE_FIELD_MAPPINGS).map((m) => m.publisher).filter(Boolean)),
);

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

  const toNullableStr = (val: unknown): string | null | undefined => {
    if (val === undefined) return undefined;
    if (val === null) return null;
    return typeof val === 'string' ||
      typeof val === 'number' ||
      typeof val === 'boolean'
      ? String(val)
      : '';
  };

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
    typeof rawTitleVal === 'string' || typeof rawTitleVal === 'number'
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
  const rawVolume = firstDefined(['volume', baseMap.volume]) as string | number | null | undefined;
  const rawIssue = firstDefined(['issue', baseMap.issue, baseMap.number]) as string | number | null | undefined;
  const rawPages = firstDefined(['pages', baseMap.pages]) as string | number | null | undefined;
  const rawAbstract = toNullableStr(firstDefined(['abstract', 'abstractNote']));
  const rawJournalAbbr = toNullableStr(firstDefined(['journalAbbr', 'journalAbbreviation']));
  const rawRights = toNullableStr(firstDefined(['rights', 'license']));
  const rawLicense = toNullableStr(firstDefined(['license', 'rights']));
  const rawEdition = firstDefined(['edition']) as string | number | null | undefined;
  const rawAccessDate = toNullableStr(firstDefined(['accessDate']));
  const rawUrl = toNullableStr(firstDefined(['url', 'URL']));

  const extraKv = extractExtraKeyValues(data.extra);
  const rawCitationKey =
    toNullableStr(firstDefined(['citationKey', 'citeKey'])) ??
    extraKv['citation-key'] ??
    extraKv['citationkey'] ??
    extraKv['bibtex'] ??
    extraKv['tex.ids']?.split(/[,\s]+/)[0];

  const resolvedCitationKey =
    rawCitationKey?.trim() ||
    generateCitationKey({
      title: rawTitle,
      year: extractedYear ?? (data.year !== undefined ? Number(data.year) : null),
      creators: Array.isArray(data.creators) ? (data.creators as any) : null,
      authors: Array.isArray(data.authors) ? (data.authors as any) : null,
    });

  const candidateType = toNullableStr(firstDefined(['type']))?.trim() || '';
  const rawTypeField =
    candidateType && candidateType.toLowerCase() !== targetItemType.toLowerCase()
      ? candidateType
      : undefined;

  const harmonizedProbe = harmonizeZoteroFields(
    { ...dataRecord, itemType: targetItemType, extraFields: { ...effectiveExtraFields } },
    { itemType: targetItemType, syncExtraFields: true },
  );
  if (harmonizedProbe.extraFields && typeof harmonizedProbe.extraFields === 'object') {
    for (const [k, v] of Object.entries(harmonizedProbe.extraFields as Record<string, unknown>)) {
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
    rawCitationKey: resolvedCitationKey,
    rawTypeField,
  };
}

export const DIRECT_STRING_METADATA_KEYS = [
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

export function buildMetadataPartial(params: {
  mode: 'create' | 'update';
  baseMeta: Record<string, unknown>;
  data: CreateItemData | UpdateItemData;
  canonical: CanonicalCommandFields;
  ids: ReturnType<typeof normalizeItemIdentifiers>;
  rawTags?: (TagInput | null | undefined)[];
  existingRawExtra?: string | null;
  uploadedById?: string;
}): Record<string, unknown> {
  const { mode, baseMeta, data, canonical, ids, existingRawExtra, uploadedById } = params;
  const isCreate = mode === 'create';
  const dataRecord = data as Record<string, unknown>;
  const dataExtra = data.extraFields && typeof data.extraFields === 'object' ? data.extraFields : {};
  const getRawField = (key: string): unknown =>
    dataRecord[key] !== undefined ? dataRecord[key] : dataExtra[key];

  const formatTrimmedOrNull = (val: string | number | null | undefined) =>
    val === undefined ? (isCreate ? '' : undefined) : val === null ? (isCreate ? '' : null) : String(val).trim();
  const formatPositiveCount = (val: unknown) =>
    val === undefined ? (isCreate ? null : undefined) : val && Number(val) > 0 ? Number(val) : null;

  const result: Record<string, unknown> = { ...baseMeta };
  const setIfDefined = (key: string, val: unknown) => {
    if (val !== undefined) result[key] = val;
  };

  setIfDefined('publicationTitle', isCreate ? (canonical.rawPubTitle ?? '').trim() : canonical.rawPubTitle);
  const createDateStr = (canonical.rawPubDate ?? '').trim() || (data.year ? String(data.year) : '');
  if (isCreate) {
    result.publicationDate = createDateStr;
    result.date = createDateStr;
  } else if (canonical.rawPubDate !== undefined) {
    result.publicationDate = canonical.rawPubDate;
    result.date = canonical.rawPubDate;
  }

  setIfDefined('publisher', isCreate ? (canonical.rawPublisher ?? '').trim() : canonical.rawPublisher);
  setIfDefined('place', isCreate ? (canonical.rawPlace ?? '').trim() : canonical.rawPlace);
  setIfDefined('volume', formatTrimmedOrNull(canonical.rawVolume));
  setIfDefined('issue', formatTrimmedOrNull(canonical.rawIssue));
  setIfDefined('pages', formatTrimmedOrNull(canonical.rawPages));
  setIfDefined('edition', formatTrimmedOrNull(canonical.rawEdition));
  if (canonical.rawTypeField !== undefined) result.type = canonical.rawTypeField;

  for (const key of DIRECT_STRING_METADATA_KEYS) {
    const rawVal = getRawField(key);
    if (isCreate) {
      result[key] = typeof rawVal === 'string' ? rawVal.trim() : typeof rawVal === 'number' ? String(rawVal) : '';
    } else if (dataRecord[key] !== undefined) {
      result[key] = dataRecord[key];
    }
  }

  const rawSeriesNumber = getRawField('seriesNumber');
  if (isCreate) {
    result.seriesNumber =
      typeof rawSeriesNumber === 'string' || typeof rawSeriesNumber === 'number' ? String(rawSeriesNumber).trim() : '';
  } else if (data.seriesNumber !== undefined) {
    result.seriesNumber = data.seriesNumber;
  }

  setIfDefined('abstractNote', isCreate ? (canonical.rawAbstract ?? '') : canonical.rawAbstract);
  setIfDefined('issn', isCreate ? (ids.issn ?? '') : ids.issn);
  setIfDefined('isbn', isCreate ? (ids.isbn ?? '') : ids.isbn);
  setIfDefined('pmid', isCreate ? (ids.pmid ?? '') : ids.pmid);
  setIfDefined('pmcid', isCreate ? (ids.pmcid ?? '') : ids.pmcid);
  setIfDefined('arxivId', isCreate ? (ids.arxivId ?? '') : ids.arxivId);
  setIfDefined('journalAbbr', isCreate ? (canonical.rawJournalAbbr ?? '').trim() : canonical.rawJournalAbbr);
  setIfDefined('rights', isCreate ? (canonical.rawRights ?? '').trim() : canonical.rawRights);
  setIfDefined('license', isCreate ? (canonical.rawLicense ?? '').trim() : data.license);

  if (isCreate) {
    result.accessedAt = data.accessedAt ?? (canonical.rawAccessDate ? parseAccessDate(canonical.rawAccessDate) : null);
  } else if (data.accessedAt !== undefined) {
    result.accessedAt = data.accessedAt;
  } else if (canonical.rawAccessDate !== undefined) {
    result.accessedAt = parseAccessDate(canonical.rawAccessDate ?? undefined) ?? null;
  }

  setIfDefined('citationCount', formatPositiveCount(data.citationCount));
  setIfDefined('referenceCount', formatPositiveCount(data.referenceCount));
  if (!isCreate && data.isMyPublication !== undefined) result.isMyPublication = data.isMyPublication;

  const { effectiveExtraFields } = canonical;
  if (isCreate) {
    result.extra = resolveExtraPlainText(data.extra, null, effectiveExtraFields) ?? '';
    if (uploadedById) result.uploadedById = uploadedById;
  } else if (data.extra !== undefined || effectiveExtraFields) {
    result.extra = resolveExtraPlainText(data.extra, existingRawExtra, effectiveExtraFields) ?? existingRawExtra ?? '';
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

  const effectiveProjectId =
    (projectId && projectId !== 'user' && isUuid(projectId)
      ? projectId
      : undefined) ||
    (data.projectId && isUuid(data.projectId) ? data.projectId : null);

  const notes = prepareNotesToCreate(
    data.notes,
    userId,
    data.uploadedById || userId,
    undefined,
    effectiveProjectId,
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
    doi: ids.doi || null,
    abstract: canonical.rawAbstract || null,
    url: (canonical.rawUrl ?? '').trim() || null,
    citationKey: (canonical.rawCitationKey ?? '').trim()
      ? await disambiguateCitationKey(
          client,
          canonical.rawCitationKey!.trim(),
          { userId, projectId: effectiveProjectId },
        )
      : null,
    metadata: metadataPayload as Prisma.InputJsonValue,
    hasFile,
    attachmentCount: attachmentsToCreate.length,
    noteCount: notes.length,
    firstAuthor,
    projectId: effectiveProjectId,
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
  cleanIds: ReturnType<typeof normalizeItemIdentifiers>;
  rawTags?: (TagInput | null | undefined)[];
} {
  const ids = normalizeItemIdentifiers(data);
  const targetItemType = (data.itemType ??
    data.type ??
    existing.itemType ??
    existing.type ??
    'journalArticle') as string;
  const rawTags = data.tags || data.keywords || data.labels;
  const existingRawExtra =
    typeof existing.extra === 'string' ? existing.extra.trim() : '';
  const canonical = resolveCanonicalCommandFields(
    data,
    targetItemType,
    {},
  );
  const cleanAbstract =
    canonical.rawAbstract !== undefined
      ? (cleanAbstractText(canonical.rawAbstract) ?? canonical.rawAbstract)
      : existing.abstract;

  const existingNoteList = existing.notesList || existing.notes;
  const existingProjectId =
    (existing as Record<string, unknown>).projectId &&
    typeof (existing as Record<string, unknown>).projectId === 'string'
      ? ((existing as Record<string, unknown>).projectId as string)
      : null;
  const newNotesToCreate = prepareNotesToCreate(
    data.notes,
    userId,
    data.userId || (existing.uploadedById as string | undefined) || userId,
    existingNoteList,
    existingProjectId,
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

  let existingMeta: Record<string, unknown> = {};
  if (
    existing.metadata &&
    typeof existing.metadata === 'object' &&
    !Array.isArray(existing.metadata)
  ) {
    existingMeta = existing.metadata as Record<string, unknown>;
  } else if (
    typeof existing.metadata === 'string' &&
    existing.metadata.trim().startsWith('{')
  ) {
    try {
      const parsed: unknown = JSON.parse(existing.metadata);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        existingMeta = parsed as Record<string, unknown>;
      }
    } catch {
      existingMeta = {};
    }
  }

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

  let collectionItemsPatch:
    | Prisma.CollectionItemUpdateManyWithoutItemNestedInput
    | undefined;
  if (data.collectionIds !== undefined) {
    const unique = Array.from(
      new Set(
        (Array.isArray(data.collectionIds) ? data.collectionIds : []).filter(
          (cid: string): cid is string =>
            typeof cid === 'string' && cid.trim().length > 0,
        ),
      ),
    );
    collectionItemsPatch =
      unique.length > 0
        ? {
            deleteMany: {},
            create: unique.map((cid, idx) => ({
              collection: { connect: { id: cid } },
              sortOrder: idx,
            })),
          }
        : { deleteMany: {} };
  } else if (data.collectionId !== undefined) {
    collectionItemsPatch =
      data.collectionId &&
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
      | string
      | null
      | undefined,
    abstract: cleanAbstract as string | null | undefined,
    url: (canonical.rawUrl !== undefined ? canonical.rawUrl : existing.url) as
      | string
      | null
      | undefined,
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
            (Array.isArray(existingNoteList)
              ? existingNoteList.length
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

  return { updateData, cleanIds: ids, rawTags };
}

export const IDENTIFIER_URI_BUILDERS: ReadonlyArray<{
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
  cleanIds: ReturnType<typeof normalizeItemIdentifiers>,
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

export { disambiguateCitationKey } from './citation-key.engine';
