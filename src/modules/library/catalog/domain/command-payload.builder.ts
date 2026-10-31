import { Prisma, TagType } from '@prisma/client';
import { PrismaService } from '@/core';
import { generateCitationKey } from '@/modules/library/core/domain/identifier.domain';
import {
  sanitizeItemTitle,
  getEffectiveBaseFieldMap,
  harmonizeZoteroFields,
} from '@/modules/library/core';
import {
  ITEM_COLUMN_METADATA_FIELDS,
  FIELD_ALIASES,
  BASE_FIELD_MAPPINGS,
} from '@/modules/library/catalog/types/items.constants';
import {
  CreateItemData,
  UpdateItemData,
} from '@/modules/library/core/types/bibliographic.types';
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
  applyManualEditProvenanceLocks,
} from './creator-tag-payload.builder';
import {
  buildDeduplicatedIdentifiers,
  buildCollectionItemsUpdatePatch,
  syncMetadataIdentifierAliases,
  syncCreatedIdentifiers,
  syncUpdatedIdentifiers,
  IDENTIFIER_URI_BUILDERS,
  calculateIdentifierChanges,
  buildMyPublicationMetadata,
} from './identifier-change.helper';
import { disambiguateCitationKey } from './citation-key.engine';
import {
  buildMetadataPartial,
  buildCommandUpdateInput,
  buildUpdateItemPayload,
} from './command-update-payload.builder';

export * from './creator-tag-payload.builder';
export type { ResolvedTag };
export {
  IDENTIFIER_URI_BUILDERS,
  buildDeduplicatedIdentifiers,
  calculateIdentifierChanges,
  buildMyPublicationMetadata,
  buildCollectionItemsUpdatePatch,
  syncMetadataIdentifierAliases,
  syncCreatedIdentifiers,
  syncUpdatedIdentifiers,
  disambiguateCitationKey,
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
  applyManualEditProvenanceLocks,
  buildMetadataPartial,
  buildCommandUpdateInput,
  buildUpdateItemPayload,
};

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
  suppliedCitationKey?: string | null;
  rawTypeField: string | null | undefined;
}

export const VENUE_BASE_FIELDS: ReadonlyArray<string> = Array.from(
  new Set([
    ...Object.values(BASE_FIELD_MAPPINGS)
      .map((m) => m.publicationTitle)
      .filter(Boolean),
    'reporter',
    'code',
  ]),
);
export const ALL_MAPPED_PUB_TITLE_KEYS: ReadonlyArray<string> =
  VENUE_BASE_FIELDS;

export const ALL_MAPPED_PUBLISHER_KEYS: ReadonlyArray<string> = Array.from(
  new Set(
    Object.values(BASE_FIELD_MAPPINGS)
      .map((m) => m.publisher)
      .filter(Boolean),
  ),
);

export const COUPLED_TYPE_SPECIFIC_TO_BASE: Readonly<
  Record<string, ReadonlyArray<string>>
> = {
  reporter: ['publicationTitle'],
  code: ['publicationTitle'],
  caseName: ['title'],
  nameOfAct: ['title'],
  subject: ['title'],
  eventPlace: ['place'],
  country: ['place'],
  dateDecided: ['date', 'publicationDate'],
  dateEnacted: ['date', 'publicationDate'],
  issueDate: ['date', 'publicationDate'],
  reporterVolume: ['volume'],
  codeNumber: ['volume'],
  firstPage: ['pages'],
  court: ['authority'],
  issuingAuthority: ['authority'],
  docketNumber: ['issue', 'number'],
  publicLawNumber: ['issue', 'number'],
  patentNumber: ['issue', 'number'],
  reportNumber: ['issue', 'number'],
};

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
    let sawNull = false;
    for (const k of keys) {
      if (!k) continue;
      const val = getVal(k);
      if (val !== undefined && val !== null) return val;
      if (val === null) sawNull = true;
    }
    return sawNull ? null : undefined;
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
    (() => {
      const candidate = firstDefined(
        targetItemType === 'preprint'
          ? ['repository', 'archive', 'institution', 'publisher']
          : [
              baseMap.publicationTitle,
              'publicationTitle',
              'journal',
              ...VENUE_BASE_FIELDS,
            ],
      );
      if (candidate !== undefined) return candidate;
      return targetItemType === 'preprint' &&
        Boolean(
          getVal('arxivId') ||
          getVal('archiveId') ||
          (typeof getVal('doi') === 'string' &&
            /^10\.48550\/arxiv\./i.test(String(getVal('doi')))),
        )
        ? 'arXiv'
        : undefined;
    })(),
  );
  const rawPublisher = toNullableStr(
    firstDefined(
      dataRecord.publisher !== undefined || dataExtra.publisher !== undefined
        ? [
            'publisher',
            baseMap.publisher,
            'repository',
            ...ALL_MAPPED_PUBLISHER_KEYS,
          ]
        : [
            baseMap.publisher,
            'publisher',
            'repository',
            ...ALL_MAPPED_PUBLISHER_KEYS,
          ],
    ),
  );

  const mappedTitleKey = baseMap.title;
  const rawTitleVal = firstDefined(
    mappedTitleKey && getVal(mappedTitleKey) !== undefined
      ? [mappedTitleKey, 'title', 'caseName', 'nameOfAct', 'subject']
      : ['title', mappedTitleKey, 'caseName', 'nameOfAct', 'subject'],
  );
  const rawTitle =
    typeof rawTitleVal === 'string' || typeof rawTitleVal === 'number'
      ? String(rawTitleVal)
      : rawTitleVal === null
        ? ''
        : undefined;
  if (mappedTitleKey && rawTitle !== undefined) {
    effectiveExtraFields[mappedTitleKey] = rawTitle.trim()
      ? getVal(mappedTitleKey) || rawTitle.trim()
      : null;
  }

  const dateCandidates =
    targetItemType === 'patent' && existingParsedFields != null
      ? [
          baseMap.date,
          'date',
          'publicationDate',
          'dateDecided',
          'dateEnacted',
          'issueDate',
        ]
      : [
          baseMap.date,
          'date',
          'publicationDate',
          'filingDate',
          'dateDecided',
          'dateEnacted',
          'issueDate',
        ];
  const rawPubDate = toNullableStr(firstDefined(dateCandidates));
  const parsedYearMatch =
    rawPubDate !== undefined && rawPubDate !== null
      ? String(rawPubDate).match(/(?:^|[^\d])(1\d{3}|20\d{2})(?:[^\d]|$)/)
      : null;
  const extractedYear = parsedYearMatch
    ? parseInt(parsedYearMatch[1], 10)
    : null;

  const rawPlace = toNullableStr(
    firstDefined(
      dataRecord.place !== undefined || dataExtra.place !== undefined
        ? ['place', baseMap.place, 'eventPlace', 'country']
        : [baseMap.place, 'eventPlace', 'country', 'place'],
    ),
  );
  const rawVolume = firstDefined([
    baseMap.volume,
    'reporterVolume',
    'codeNumber',
    'volume',
  ]) as string | number | null | undefined;
  const rawIssue = firstDefined([
    baseMap.issue,
    baseMap.number,
    'docketNumber',
    'publicLawNumber',
    'patentNumber',
    'reportNumber',
    'issue',
    'number',
  ]) as string | number | null | undefined;
  const rawPages = firstDefined([baseMap.pages, 'firstPage', 'pages']) as
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
  const explicitCitKey = toNullableStr(
    firstDefined(['citationKey', 'citeKey']),
  );
  const rawCitationKey =
    explicitCitKey !== undefined
      ? explicitCitKey
      : (extraKv['citation-key'] ??
        extraKv['citationkey'] ??
        extraKv['bibtex'] ??
        extraKv['tex.ids']?.split(/[,\s]+/)[0]);

  const effectiveAuthorsForCitKey = Array.isArray(data.authors)
    ? data.authors
    : typeof (data as Record<string, unknown>).author === 'string' &&
        String((data as Record<string, unknown>).author).trim()
      ? [String((data as Record<string, unknown>).author).trim()]
      : null;

  const resolvedCitationKey =
    rawCitationKey?.trim() ||
    generateCitationKey({
      title: rawTitle,
      year:
        extractedYear ?? (data.year !== undefined ? Number(data.year) : null),
      creators: Array.isArray(data.creators) ? data.creators : null,
      authors: effectiveAuthorsForCitKey,
    });

  const rawMappedTypeInput = firstDefined([baseMap.type, baseMap.medium]);
  const rawGenericTypeVal = getVal('type');
  const hasExplicitGenericType =
    rawGenericTypeVal !== undefined &&
    String(rawGenericTypeVal ?? '')
      .trim()
      .toLowerCase() !== targetItemType.toLowerCase();
  const rawTypeInput = hasExplicitGenericType
    ? rawGenericTypeVal
    : rawMappedTypeInput;
  const candidateType = toNullableStr(rawTypeInput)?.trim() || '';
  const rawTypeField =
    rawTypeInput === null ||
    (typeof rawTypeInput === 'string' && rawTypeInput.trim() === '')
      ? null
      : candidateType &&
          candidateType.toLowerCase() !== targetItemType.toLowerCase()
        ? candidateType
        : undefined;

  const harmonizedProbe = harmonizeZoteroFields(
    {
      ...dataRecord,
      itemType: targetItemType,
      extraFields: { ...effectiveExtraFields, ...dataExtra },
    },
    { itemType: targetItemType, syncExtraFields: true },
  );
  const probeRec = harmonizedProbe as Record<string, unknown>;
  const syncedExtra: Record<string, unknown> = {
    ...(harmonizedProbe.extraFields &&
    typeof harmonizedProbe.extraFields === 'object'
      ? harmonizedProbe.extraFields
      : {}),
  };
  for (const hk of [
    'numPages',
    'numberOfPages',
    'authority',
    'issuingAuthority',
    'originalDate',
    'status',
  ]) {
    if (probeRec[hk] !== undefined && syncedExtra[hk] === undefined) {
      syncedExtra[hk] = probeRec[hk];
    }
  }
  for (const [k, v] of Object.entries(syncedExtra)) {
    if (
      v !== undefined &&
      effectiveExtraFields[k] === undefined &&
      !ITEM_COLUMN_METADATA_FIELDS.has(k) &&
      !FIELD_ALIASES[k]
    ) {
      effectiveExtraFields[k] = v;
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
    suppliedCitationKey:
      explicitCitKey !== undefined &&
      (explicitCitKey === null || explicitCitKey.trim() === '')
        ? null
        : rawCitationKey?.trim()
          ? rawCitationKey.trim()
          : undefined,
    rawTypeField,
  };
}

export async function buildCommandCreateInput(
  userId: string,
  data: CreateItemData,
  client: Prisma.TransactionClient | PrismaService,
  projectId?: string,
): Promise<{
  createData: Prisma.ItemUncheckedCreateInput;
  resolvedFileId: string | null;
  identifiersToCreate: Array<{
    type: string;
    value: string;
    canonicalUri: string | null;
  }>;
}> {
  const dataRecord = data as Record<string, unknown>;
  if (
    typeof dataRecord.author === 'string' &&
    dataRecord.author.trim() &&
    data.creators === undefined &&
    data.contributors === undefined &&
    data.authors === undefined
  ) {
    data = { ...data, authors: [dataRecord.author.trim()] };
  }

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

  const extraKv = extractExtraKeyValues(data.extra);
  const rawCommentFromExtra =
    extraKv['comment'] ||
    extraKv['comments'] ||
    (typeof data.extra === 'string'
      ? data.extra
          .split(/\r?\n/)
          .map((l) => l.match(/^\s*comments?:\s*(.+)$/i)?.[1]?.trim())
          .find(Boolean)
      : undefined);
  const explicitNotesList = Array.isArray(data.notes) ? [...data.notes] : [];
  if (rawCommentFromExtra) {
    const formattedComment = rawCommentFromExtra
      .toLowerCase()
      .startsWith('comment:')
      ? rawCommentFromExtra
      : `Comment: ${rawCommentFromExtra}`;
    explicitNotesList.push({ content: formattedComment, source: 'arXiv' });
  }
  const notes = prepareNotesToCreate(
    explicitNotesList.length > 0 ? explicitNotesList : data.notes,
    userId,
    data.uploadedById || userId,
    undefined,
    effectiveProjectId,
  );
  const attachmentsToCreate = prepareAttachmentsToCreate(
    data.attachments,
    resolvedFileId,
    data,
    userId,
  );
  const hasFile = attachmentsToCreate.length > 0;

  const ids = normalizeItemIdentifiers(data);
  const rawTagList = [
    ...(data.tags || []),
    ...(data.keywords || []),
    ...(data.labels || []),
  ];
  const defaultTagType =
    (data.keywords && data.keywords.length > 0) ||
    (data.labels && data.labels.length > 0) ||
    Boolean(data.fileId || data.doi || data.arxivId || data.pmid || data.isbn)
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
  const firstAuthor =
    contributorsToCreate !== null
      ? deriveFirstAuthor({
          contributors: contributorsToCreate,
          itemType: resolvedItemType,
        })
      : deriveFirstAuthor({ ...data, itemType: resolvedItemType });

  const rawUniqueCollectionIds = Array.from(
    new Set(
      [
        ...(Array.isArray(data.collectionIds) ? data.collectionIds : []),
        ...(Array.isArray((data as { collections?: unknown }).collections)
          ? (data as unknown as { collections: string[] }).collections
          : []),
        ...(data.collectionId ? [data.collectionId] : []),
      ].filter(
        (id): id is string => typeof id === 'string' && id.trim().length > 0,
      ),
    ),
  );
  let uniqueCollectionIds = rawUniqueCollectionIds;
  if (rawUniqueCollectionIds.length > 0 && client.collection) {
    const validCollections = await client.collection.findMany({
      where: effectiveProjectId
        ? {
            id: { in: rawUniqueCollectionIds },
            projectId: effectiveProjectId,
            deletedAt: null,
          }
        : {
            id: { in: rawUniqueCollectionIds },
            userId,
            projectId: null,
            deletedAt: null,
          },
      select: { id: true },
    });
    if (Array.isArray(validCollections)) {
      const validSet = new Set(validCollections.map((c) => c.id));
      uniqueCollectionIds = rawUniqueCollectionIds.filter((cid) =>
        validSet.has(cid),
      );
    }
  }

  const identifiersToCreate = buildDeduplicatedIdentifiers(
    ids,
    (
      data as {
        identifiers?: ReadonlyArray<{
          type: string;
          value: string;
          canonicalUri?: string | null;
        }>;
      }
    ).identifiers,
  );

  const createData = {
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
          {
            userId,
            projectId: effectiveProjectId,
          },
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
  } as unknown as Prisma.ItemUncheckedCreateInput;

  return { createData, resolvedFileId, identifiersToCreate };
}
