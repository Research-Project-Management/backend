import { Prisma, TagType } from '@prisma/client';
import { PrismaService } from '@/core';
import { generateCitationKey } from '@/modules/library/core/domain/identifier.domain';
import {
  cleanAbstractText, getEffectiveBaseFieldMap, getEffectiveReverseBaseFieldMap,
  getPrimaryCreatorRoleForType, getValidCreatorMapForType, harmonizeZoteroFields, sanitizeItemTitle,
} from '@/modules/library/core';
import {
  ITEM_COLUMN_METADATA_FIELDS, FIELD_ALIASES, BASE_FIELD_MAPPINGS, parseAccessDate, TagInput,
} from '@/modules/library/catalog/types/catalog.types';
import { CreateItemData, UpdateItemData, ItemDetail } from '@/modules/library/core/types/bibliographic.types';
import {
  isUuid, cleanSingleIdentifier, extractExtraKeyValues, normalizeItemIdentifiers, resolveExtraPlainText,
  extractNonColumnExtraFields, convertHtmlToMarkdown, buildTipTapDocFromText, prepareNotesToCreate,
  prepareAttachmentsToCreate, deriveFirstAuthor, prepareContributorsToCreate, applyManualEditProvenanceLocks,
  prepareItemAiMetadataPatch, buildImportItemPayload, ImportSourceItem, AiMetadataPatchPreparation,
} from './creator-tag-payload.builder';
import {
  buildDeduplicatedIdentifiers, buildCollectionItemsUpdatePatch, syncMetadataIdentifierAliases,
  IDENTIFIER_URI_BUILDERS, calculateIdentifierChanges, buildMyPublicationMetadata, applyMetadataProvenanceAndTelemetry,
} from './identifier-change.helper';
import {
  disambiguateCitationKey, resolveOrCreateTags, syncTagsForCatalogItem, buildTagTypeMap,
  ResolvedTag, syncCreatedIdentifiers, syncUpdatedIdentifiers,
} from '../repositories/command-relations.helper';

export * from './creator-tag-payload.builder';
export type { ResolvedTag, ImportSourceItem, AiMetadataPatchPreparation };
export {
  ITEM_COLUMN_METADATA_FIELDS, IDENTIFIER_URI_BUILDERS, buildDeduplicatedIdentifiers, calculateIdentifierChanges,
  buildMyPublicationMetadata, buildCollectionItemsUpdatePatch, syncMetadataIdentifierAliases, syncCreatedIdentifiers,
  syncUpdatedIdentifiers, disambiguateCitationKey, isUuid, cleanSingleIdentifier, extractExtraKeyValues,
  normalizeItemIdentifiers, resolveExtraPlainText, extractNonColumnExtraFields, convertHtmlToMarkdown,
  buildTipTapDocFromText, prepareNotesToCreate, prepareAttachmentsToCreate, resolveOrCreateTags,
  syncTagsForCatalogItem, deriveFirstAuthor, prepareContributorsToCreate, buildTagTypeMap,
  applyManualEditProvenanceLocks, prepareItemAiMetadataPatch, buildImportItemPayload,
};

export interface CanonicalCommandFields {
  itemType: string; baseMap: Record<string, string>; effectiveExtraFields: Record<string, unknown>;
  rawTitle: string | undefined; rawPubTitle: string | null | undefined; rawPublisher: string | null | undefined;
  rawPubDate: string | null | undefined; extractedYear: number | null; rawPlace: string | null | undefined;
  rawVolume: string | number | null | undefined; rawIssue: string | number | null | undefined;
  rawPages: string | number | null | undefined; rawAbstract: string | null | undefined;
  rawJournalAbbr: string | null | undefined; rawRights: string | null | undefined;
  rawLicense: string | null | undefined; rawEdition: string | number | null | undefined;
  rawAccessDate: string | null | undefined; rawUrl: string | null | undefined;
  rawCitationKey: string | null | undefined; suppliedCitationKey?: string | null;
  rawTypeField: string | null | undefined;
}

export const VENUE_BASE_FIELDS: ReadonlyArray<string> = Array.from(
  new Set([...Object.values(BASE_FIELD_MAPPINGS).map((m) => m.publicationTitle).filter(Boolean), 'reporter', 'code']),
);
export const ALL_MAPPED_PUB_TITLE_KEYS: ReadonlyArray<string> = VENUE_BASE_FIELDS;
export const ALL_MAPPED_PUBLISHER_KEYS: ReadonlyArray<string> = Array.from(
  new Set(Object.values(BASE_FIELD_MAPPINGS).map((m) => m.publisher).filter(Boolean)),
);
export const COUPLED_TYPE_SPECIFIC_TO_BASE: Readonly<Record<string, ReadonlyArray<string>>> = {
  reporter: ['publicationTitle'], code: ['publicationTitle'], caseName: ['title'],
  nameOfAct: ['title'], subject: ['title'], eventPlace: ['place'], country: ['place'],
  dateDecided: ['date', 'publicationDate'], dateEnacted: ['date', 'publicationDate'],
  issueDate: ['date', 'publicationDate'], reporterVolume: ['volume'], codeNumber: ['volume'],
  firstPage: ['pages'], court: ['authority'], issuingAuthority: ['authority'],
  docketNumber: ['issue', 'number'], publicLawNumber: ['issue', 'number'],
  patentNumber: ['issue', 'number'], reportNumber: ['issue', 'number'],
};
export const DIRECT_STRING_METADATA_KEYS = [
  'section', 'partNumber', 'partTitle', 'series', 'seriesTitle', 'seriesText',
  'language', 'shortTitle', 'libraryCatalog', 'archive', 'archiveLocation',
  'callNumber', 'openAccessPdfUrl',
] as const;

export function resolveCanonicalCommandFields(
  data: CreateItemData | UpdateItemData, targetItemType: string, existingParsedFields?: Record<string, unknown> | null,
): CanonicalCommandFields {
  const dataRecord = data as Record<string, unknown>;
  const dataExtra = data.extraFields && typeof data.extraFields === 'object' ? data.extraFields : {};
  const getVal = (key: string): unknown => (dataRecord[key] !== undefined ? dataRecord[key] : dataExtra[key]);
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
  const toNullableStr = (val: unknown): string | null | undefined =>
    val === undefined ? undefined : val === null ? null : typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean' ? String(val) : '';

  const baseMap = getEffectiveBaseFieldMap(targetItemType);
  const effectiveExtraFields = extractNonColumnExtraFields(data, existingParsedFields ?? null);
  const rawPubTitle = toNullableStr(
    (() => {
      const candidate = firstDefined(
        targetItemType === 'preprint' ? ['repository', 'archive', 'institution', 'publisher'] : [baseMap.publicationTitle, 'publicationTitle', 'journal', ...VENUE_BASE_FIELDS],
      );
      if (candidate !== undefined) return candidate;
      return targetItemType === 'preprint' &&
        Boolean(getVal('arxivId') || getVal('archiveId') || (typeof getVal('doi') === 'string' && /^10\.48550\/arxiv\./i.test(String(getVal('doi')))))
        ? 'arXiv' : undefined;
    })(),
  );
  const rawPublisher = toNullableStr(
    firstDefined(
      dataRecord.publisher !== undefined || dataExtra.publisher !== undefined
        ? ['publisher', baseMap.publisher, 'repository', ...ALL_MAPPED_PUBLISHER_KEYS]
        : [baseMap.publisher, 'publisher', 'repository', ...ALL_MAPPED_PUBLISHER_KEYS],
    ),
  );
  const mappedTitleKey = baseMap.title;
  const rawTitleVal = firstDefined(
    mappedTitleKey && getVal(mappedTitleKey) !== undefined ? [mappedTitleKey, 'title', 'caseName', 'nameOfAct', 'subject'] : ['title', mappedTitleKey, 'caseName', 'nameOfAct', 'subject'],
  );
  const rawTitle = typeof rawTitleVal === 'string' || typeof rawTitleVal === 'number' ? String(rawTitleVal) : rawTitleVal === null ? '' : undefined;
  if (mappedTitleKey && rawTitle !== undefined) {
    effectiveExtraFields[mappedTitleKey] = rawTitle.trim() ? getVal(mappedTitleKey) || rawTitle.trim() : null;
  }

  const dateCandidates =
    targetItemType === 'patent' && existingParsedFields != null
      ? [baseMap.date, 'date', 'publicationDate', 'dateDecided', 'dateEnacted', 'issueDate']
      : [baseMap.date, 'date', 'publicationDate', 'filingDate', 'dateDecided', 'dateEnacted', 'issueDate'];
  const rawPubDate = toNullableStr(firstDefined(dateCandidates));
  const parsedYearMatch = rawPubDate !== undefined && rawPubDate !== null ? String(rawPubDate).match(/(?:^|[^\d])(1\d{3}|20\d{2})(?:[^\d]|$)/) : null;
  const extractedYear = parsedYearMatch ? parseInt(parsedYearMatch[1], 10) : null;

  const rawPlace = toNullableStr(
    firstDefined(dataRecord.place !== undefined || dataExtra.place !== undefined ? ['place', baseMap.place, 'eventPlace', 'country'] : [baseMap.place, 'eventPlace', 'country', 'place']),
  );
  const rawVolume = firstDefined([baseMap.volume, 'reporterVolume', 'codeNumber', 'volume']) as string | number | null | undefined;
  const rawIssue = firstDefined([baseMap.issue, baseMap.number, 'docketNumber', 'publicLawNumber', 'patentNumber', 'reportNumber', 'issue', 'number']) as string | number | null | undefined;
  const rawPages = firstDefined([baseMap.pages, 'firstPage', 'pages']) as string | number | null | undefined;
  const rawAbstract = toNullableStr(firstDefined(['abstract', 'abstractNote']));
  const rawJournalAbbr = toNullableStr(firstDefined(['journalAbbr', 'journalAbbreviation']));
  const rawRights = toNullableStr(firstDefined(['rights', 'license']));
  const rawLicense = toNullableStr(firstDefined(['license', 'rights']));
  const rawEdition = firstDefined(['edition']) as string | number | null | undefined;
  const rawAccessDate = toNullableStr(firstDefined(['accessDate']));
  const rawUrl = toNullableStr(firstDefined(['url', 'URL']));

  const extraKv = extractExtraKeyValues(data.extra);
  const explicitCitKey = toNullableStr(firstDefined(['citationKey', 'citeKey']));
  const rawCitationKey =
    explicitCitKey !== undefined ? explicitCitKey : (extraKv['citation-key'] ?? extraKv['citationkey'] ?? extraKv['bibtex'] ?? extraKv['tex.ids']?.split(/[,\s]+/)[0]);
  const effectiveAuthorsForCitKey = Array.isArray(data.authors)
    ? data.authors
    : typeof dataRecord.author === 'string' && dataRecord.author.trim() ? [dataRecord.author.trim()] : null;
  const resolvedCitationKey =
    rawCitationKey?.trim() ||
    generateCitationKey({
      title: rawTitle, year: extractedYear ?? (data.year !== undefined ? Number(data.year) : null),
      creators: Array.isArray(data.creators) ? data.creators : null, authors: effectiveAuthorsForCitKey,
    });

  const rawMappedTypeInput = firstDefined([baseMap.type, baseMap.medium]);
  const rawGenericTypeVal = getVal('type');
  const hasExplicitGenericType = rawGenericTypeVal !== undefined && String(rawGenericTypeVal ?? '').trim().toLowerCase() !== targetItemType.toLowerCase();
  const rawTypeInput = hasExplicitGenericType ? rawGenericTypeVal : rawMappedTypeInput;
  const candidateType = toNullableStr(rawTypeInput)?.trim() || '';
  const rawTypeField =
    rawTypeInput === null || (typeof rawTypeInput === 'string' && rawTypeInput.trim() === '')
      ? null
      : candidateType && candidateType.toLowerCase() !== targetItemType.toLowerCase() ? candidateType : undefined;

  const harmonizedProbe = harmonizeZoteroFields(
    { ...dataRecord, itemType: targetItemType, extraFields: { ...effectiveExtraFields, ...dataExtra } },
    { itemType: targetItemType, syncExtraFields: true },
  );
  const probeRec = harmonizedProbe as Record<string, unknown>;
  const syncedExtra: Record<string, unknown> = { ...(harmonizedProbe.extraFields && typeof harmonizedProbe.extraFields === 'object' ? harmonizedProbe.extraFields : {}) };
  for (const hk of ['numPages', 'numberOfPages', 'authority', 'issuingAuthority', 'originalDate', 'status']) {
    if (probeRec[hk] !== undefined && syncedExtra[hk] === undefined) syncedExtra[hk] = probeRec[hk];
  }
  for (const [k, v] of Object.entries(syncedExtra)) {
    if (v !== undefined && effectiveExtraFields[k] === undefined && !ITEM_COLUMN_METADATA_FIELDS.has(k) && !FIELD_ALIASES[k]) {
      effectiveExtraFields[k] = v;
    }
  }

  return {
    itemType: targetItemType, baseMap, effectiveExtraFields, rawTitle, rawPubTitle, rawPublisher,
    rawPubDate, extractedYear, rawPlace, rawVolume, rawIssue, rawPages, rawAbstract, rawJournalAbbr,
    rawRights, rawLicense, rawEdition, rawAccessDate, rawUrl, rawCitationKey: resolvedCitationKey,
    suppliedCitationKey:
      explicitCitKey !== undefined && (explicitCitKey === null || explicitCitKey.trim() === '')
        ? null : rawCitationKey?.trim() ? rawCitationKey.trim() : undefined,
    rawTypeField,
  };
}

export function buildMetadataPartial(params: {
  mode: 'create' | 'update'; baseMeta: Record<string, unknown>; data: CreateItemData | UpdateItemData;
  canonical: CanonicalCommandFields; ids: ReturnType<typeof normalizeItemIdentifiers>;
  rawTags?: (TagInput | null | undefined)[]; existingRawExtra?: string | null; uploadedById?: string;
}): Record<string, unknown> {
  const { mode, baseMeta, data, canonical, ids, existingRawExtra, uploadedById } = params;
  const isCreate = mode === 'create';
  const dataRecord = data as Record<string, unknown>;
  const dataExtra = data.extraFields && typeof data.extraFields === 'object' ? data.extraFields : {};
  const getRawField = (key: string): unknown => (dataRecord[key] !== undefined ? dataRecord[key] : dataExtra[key]);
  const formatTrimmedOrNull = (val: string | number | null | undefined) =>
    val === undefined ? (isCreate ? '' : undefined) : val === null ? (isCreate ? '' : null) : String(val).trim();
  const formatPositiveCount = (val: unknown) =>
    val === undefined
      ? isCreate ? null : undefined
      : val !== null && val !== '' && typeof val !== 'boolean' && Number.isFinite(Number(val)) && Number(val) >= 0 ? Number(val) : null;

  const result: Record<string, unknown> = { ...baseMeta };
  if (data.metadata && typeof data.metadata === 'object') Object.assign(result, data.metadata);
  const setIfDefined = (key: string, val: unknown) => { if (val !== undefined) result[key] = val; };

  if (canonical.itemType !== 'preprint') {
    setIfDefined('publicationTitle', isCreate ? (canonical.rawPubTitle ?? '').trim() : canonical.rawPubTitle);
  } else {
    const repoCandidate = getRawField('repository') ?? canonical.rawPublisher ?? canonical.rawPubTitle;
    if (typeof repoCandidate === 'string' && repoCandidate.trim()) {
      result.repository = repoCandidate.trim();
      result.publicationTitle = repoCandidate.trim();
    } else if (canonical.rawPubTitle !== undefined) {
      setIfDefined('publicationTitle', isCreate ? (canonical.rawPubTitle ?? '').trim() : canonical.rawPubTitle);
    }
  }
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

  for (const key of [...DIRECT_STRING_METADATA_KEYS, 'seriesNumber'] as const) {
    const rawVal = getRawField(key);
    if (isCreate) {
      result[key] = typeof rawVal === 'string' || typeof rawVal === 'number' ? String(rawVal).trim() : '';
    } else if (rawVal !== undefined) {
      result[key] = rawVal === null ? null : typeof rawVal === 'string' || typeof rawVal === 'number' ? String(rawVal).trim() : rawVal;
    }
  }

  if (isCreate) {
    setIfDefined('abstractNote', canonical.rawAbstract ?? '');
  } else if (canonical.rawAbstract !== undefined) {
    const trimmedAbstract = canonical.rawAbstract === null ? '' : String(canonical.rawAbstract).trim();
    result.abstractNote = trimmedAbstract === '' ? null : (cleanAbstractText(canonical.rawAbstract) ?? canonical.rawAbstract);
  }
  setIfDefined('issn', isCreate ? (ids.issn ?? '') : ids.issn);
  setIfDefined('isbn', isCreate ? (ids.isbn ?? '') : ids.isbn);
  setIfDefined('pmid', isCreate ? (ids.pmid ?? '') : ids.pmid);
  setIfDefined('pmcid', isCreate ? (ids.pmcid ?? '') : ids.pmcid);
  setIfDefined('arxivId', isCreate ? (ids.arxivId ?? '') : ids.arxivId);
  setIfDefined('journalAbbr', isCreate ? (canonical.rawJournalAbbr ?? '').trim() : canonical.rawJournalAbbr);
  setIfDefined('rights', isCreate ? (canonical.rawRights ?? '').trim() : canonical.rawRights);
  setIfDefined('license', isCreate ? (canonical.rawLicense ?? '').trim() : canonical.rawLicense);

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
  const extraPatchWithTombstones: Record<string, unknown> = { ...(effectiveExtraFields || {}), ...(dataExtra || {}) };
  const hasEffectiveExtraPatch = Object.keys(extraPatchWithTombstones).length > 0;
  const demotedExtraLines = Array.isArray(dataRecord.demotedExtraLines)
    ? (dataRecord.demotedExtraLines as string[])
    : Array.isArray(dataRecord.__demotedExtraLines) ? (dataRecord.__demotedExtraLines as string[]) : undefined;

  if (isCreate) {
    result.extra = resolveExtraPlainText(data.extra, null, extraPatchWithTombstones, demotedExtraLines) ?? '';
    if (uploadedById) result.uploadedById = uploadedById;
  } else if (
    data.extra === null ||
    (typeof data.extra === 'string' && data.extra.trim() === '' && (!demotedExtraLines || demotedExtraLines.length === 0))
  ) {
    result.extra = resolveExtraPlainText('', null, extraPatchWithTombstones, demotedExtraLines) ?? '';
  } else if (data.extra !== undefined || hasEffectiveExtraPatch || (demotedExtraLines && demotedExtraLines.length > 0)) {
    const resolvedExtra = resolveExtraPlainText(data.extra, existingRawExtra, extraPatchWithTombstones, demotedExtraLines);
    result.extra =
      resolvedExtra !== undefined
        ? resolvedExtra
        : data.extra !== undefined || hasEffectiveExtraPatch ? '' : (existingRawExtra ?? '');
  }

  if (effectiveExtraFields && typeof effectiveExtraFields === 'object') Object.assign(result, effectiveExtraFields);
  applyMetadataProvenanceAndTelemetry(result, dataRecord, dataExtra, { isCreate, rawTitle: canonical.rawTitle });
  const directStringSet = new Set<string>(DIRECT_STRING_METADATA_KEYS);
  for (const [k, v] of Object.entries(extraPatchWithTombstones)) {
    if (v === null) {
      if (directStringSet.has(k) && dataRecord[k] === null) result[k] = null;
      else delete result[k];
    }
  }
  if (data.metadata && typeof data.metadata === 'object') {
    for (const [k, v] of Object.entries(data.metadata)) {
      if (v === null && dataRecord[k] === undefined && dataExtra[k] === undefined) delete result[k];
    }
  }
  if (!isCreate && typeof data.extra === 'string' && existingRawExtra) {
    const oldKv = extractExtraKeyValues(existingRawExtra);
    const newKv = extractExtraKeyValues(data.extra);
    for (const [rawKey, oldVal] of Object.entries(oldKv)) {
      if (newKv[rawKey] === undefined) {
        const camelKey = rawKey.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
        if (dataRecord[camelKey] === undefined && dataExtra[camelKey] === undefined && String(result[camelKey] ?? '') === oldVal) {
          delete result[camelKey];
        }
      }
    }
  }
  syncMetadataIdentifierAliases(result, ids, {
    isCreate, itemType: canonical.itemType, rawPubTitle: canonical.rawPubTitle, rawPublisher: canonical.rawPublisher,
    rawPlace: canonical.rawPlace, rawVolume: canonical.rawVolume, rawIssue: canonical.rawIssue, rawPages: canonical.rawPages,
    rawAbstract: canonical.rawAbstract, rawUrl: canonical.rawUrl, suppliedCitationKey: canonical.suppliedCitationKey,
    year: data.year, rawPubDate: canonical.rawPubDate, rawTypeField: canonical.rawTypeField,
    mappedTypeKey: canonical.baseMap.type || canonical.baseMap.medium, baseMap: canonical.baseMap, dataRecord,
  });

  const reverseBaseMap = getEffectiveReverseBaseFieldMap(canonical.itemType);
  for (const [tsKey, baseTargets] of Object.entries(COUPLED_TYPE_SPECIFIC_TO_BASE)) {
    const rawTsVal = getRawField(tsKey);
    if (rawTsVal === undefined) continue;
    const isCleared = rawTsVal === null || (typeof rawTsVal === 'string' && rawTsVal.trim() === '');
    const coupledKeys = Array.from(new Set([...baseTargets, ...(reverseBaseMap[tsKey] ? [reverseBaseMap[tsKey]] : [])]));
    const nextVal = isCleared ? (isCreate ? '' : null) : String(rawTsVal).trim();
    result[tsKey] = nextVal;
    for (const bKey of coupledKeys) {
      if (getRawField(bKey) === undefined) result[bKey] = nextVal;
    }
  }
  for (const [baseKey, mappedKey] of Object.entries(canonical.baseMap)) {
    if (!mappedKey) continue;
    const rawBaseVal = getRawField(baseKey);
    if (rawBaseVal !== undefined && getRawField(mappedKey) === undefined) {
      const isCleared = rawBaseVal === null || (typeof rawBaseVal === 'string' && rawBaseVal.trim() === '');
      result[mappedKey] = isCleared ? (isCreate ? '' : null) : String(rawBaseVal).trim();
    }
  }

  if (data.editors !== undefined) {
    result.editors = Array.isArray(data.editors) ? data.editors : data.editors === null ? null : [];
  } else if (Array.isArray(data.creators) || Array.isArray(data.contributors)) {
    const rawList = (Array.isArray(data.creators) ? data.creators : data.contributors) as Array<Record<string, unknown>>;
    const editorNames = rawList
      .filter((c) => c && String(c.creatorType || c.role || '').trim().toLowerCase() === 'editor')
      .map((c) => String(c.fullName || c.name || [c.firstName, c.lastName].filter(Boolean).join(' ') || '').trim())
      .filter(Boolean);
    result.editors = editorNames.length > 0 ? editorNames : null;
  }

  if (data.isRetracted !== undefined) {
    result.isRetracted = Boolean(data.isRetracted);
    result.retractionNature = data.retractionNature ?? null;
    result.retractionDetails = data.retractionDetails ?? null;
    result.retractionCheckedAt = data.retractionCheckedAt ?? new Date().toISOString();
  } else if (data.retractionCheckedAt !== undefined) {
    result.retractionCheckedAt = data.retractionCheckedAt;
  }
  if (dataRecord.retractionReason !== undefined) {
    const rr = dataRecord.retractionReason;
    result.retractionReason = Array.isArray(rr)
      ? rr.filter(Boolean).join('; ') || null
      : typeof rr === 'string' ? rr.trim() || null : null;
  }
  if (dataRecord.retractionDate !== undefined) {
    const rd = dataRecord.retractionDate;
    const parsedRd = rd instanceof Date || typeof rd === 'string' ? new Date(rd) : null;
    result.retractionDate = parsedRd && !isNaN(parsedRd.getTime()) ? parsedRd.toISOString() : null;
  }
  if (isCreate) {
    if (data.relations) result.relations = data.relations;
    if ('seeAlso' in data && data.seeAlso) result.seeAlso = data.seeAlso;
  }
  return result;
}

export async function buildCommandCreateInput(
  userId: string, data: CreateItemData, client: Prisma.TransactionClient | PrismaService, projectId?: string,
): Promise<{
  createData: Prisma.ItemUncheckedCreateInput;
  resolvedFileId: string | null;
  identifiersToCreate: Array<{ type: string; value: string; canonicalUri: string | null }>;
}> {
  const dataRecord = data as Record<string, unknown>;
  if (typeof dataRecord.author === 'string' && dataRecord.author.trim() && data.creators === undefined && data.contributors === undefined && data.authors === undefined) {
    data = { ...data, authors: [dataRecord.author.trim()] };
  }

  const rawFileId = data.fileId || data.fileUrl?.match(/\/api\/files\/([a-zA-Z0-9-]+)\/content/)?.[1] || null;
  const resolvedFileId = rawFileId && isUuid(rawFileId) ? rawFileId : null;
  const effectiveProjectId =
    (projectId && projectId !== 'user' && isUuid(projectId) ? projectId : undefined) ||
    (data.projectId && isUuid(data.projectId) ? data.projectId : null);

  const extraKv = extractExtraKeyValues(data.extra);
  const rawCommentFromExtra =
    extraKv['comment'] || extraKv['comments'] ||
    (typeof data.extra === 'string' ? data.extra.split(/\r?\n/).map((l) => l.match(/^\s*comments?:\s*(.+)$/i)?.[1]?.trim()).find(Boolean) : undefined);
  const explicitNotesList = Array.isArray(data.notes) ? [...data.notes] : [];
  if (rawCommentFromExtra) {
    explicitNotesList.push({
      content: rawCommentFromExtra.toLowerCase().startsWith('comment:') ? rawCommentFromExtra : `Comment: ${rawCommentFromExtra}`,
      source: 'arXiv',
    });
  }
  const notes = prepareNotesToCreate(
    explicitNotesList.length > 0 ? explicitNotesList : data.notes, userId, data.uploadedById || userId, undefined, effectiveProjectId,
  );
  const attachmentsToCreate = prepareAttachmentsToCreate(data.attachments, resolvedFileId, data, userId);
  const hasFile = attachmentsToCreate.length > 0;

  const ids = normalizeItemIdentifiers(data);
  const rawTagList = [...(data.tags || []), ...(data.keywords || []), ...(data.labels || [])];
  const defaultTagType =
    (data.keywords && data.keywords.length > 0) || (data.labels && data.labels.length > 0) ||
    Boolean(data.fileId || data.doi || data.arxivId || data.pmid || data.isbn)
      ? TagType.automatic
      : TagType.manual;
  const resolvedTags = await resolveOrCreateTags(client, userId, rawTagList, defaultTagType, effectiveProjectId);

  const resolvedItemType = data.itemType ?? data.type ?? 'journalArticle';
  const canonical = resolveCanonicalCommandFields(data, resolvedItemType, null);
  const { effectiveExtraFields } = canonical;

  const resolvedCreateTitle = sanitizeItemTitle(canonical.rawTitle) || 'Untitled Item';
  if (canonical.baseMap.title && resolvedCreateTitle !== 'Untitled Item' && effectiveExtraFields[canonical.baseMap.title] === undefined) {
    effectiveExtraFields[canonical.baseMap.title] = resolvedCreateTitle;
  }

  const resolvedPubTitle = (canonical.rawPubTitle ?? '').trim();
  const resolvedCreateYear: number | null =
    data.year !== undefined && data.year !== null ? Number(data.year) : canonical.extractedYear;

  const metadataPayload = buildMetadataPartial({
    mode: 'create', baseMeta: {}, data, canonical, ids, rawTags: rawTagList, uploadedById: data.uploadedById || userId,
  });

  const contributorsToCreate = prepareContributorsToCreate(data, resolvedItemType);
  const firstAuthor =
    contributorsToCreate !== null
      ? deriveFirstAuthor({ contributors: contributorsToCreate, itemType: resolvedItemType })
      : deriveFirstAuthor({ ...data, itemType: resolvedItemType });

  const rawUniqueCollectionIds = Array.from(
    new Set(
      [
        ...(Array.isArray(data.collectionIds) ? data.collectionIds : []),
        ...(Array.isArray((data as { collections?: unknown }).collections) ? (data as unknown as { collections: string[] }).collections : []),
        ...(data.collectionId ? [data.collectionId] : []),
      ].filter((id): id is string => typeof id === 'string' && id.trim().length > 0),
    ),
  );
  let uniqueCollectionIds = rawUniqueCollectionIds;
  if (rawUniqueCollectionIds.length > 0 && client.collection) {
    const validCollections = await client.collection.findMany({
      where: effectiveProjectId
        ? { id: { in: rawUniqueCollectionIds }, projectId: effectiveProjectId, deletedAt: null }
        : { id: { in: rawUniqueCollectionIds }, userId, projectId: null, deletedAt: null },
      select: { id: true },
    });
    if (Array.isArray(validCollections)) {
      const validSet = new Set(validCollections.map((c) => c.id));
      uniqueCollectionIds = rawUniqueCollectionIds.filter((cid) => validSet.has(cid));
    }
  }

  const identifiersToCreate = buildDeduplicatedIdentifiers(
    ids, (data as { identifiers?: ReadonlyArray<{ type: string; value: string; canonicalUri?: string | null }> }).identifiers,
  );

  const createData = {
    userId, title: resolvedCreateTitle, itemType: resolvedItemType,
    ...(resolvedPubTitle ? { publicationTitle: resolvedPubTitle } : {}),
    year: resolvedCreateYear, doi: ids.doi || null, abstract: canonical.rawAbstract || null,
    url: (canonical.rawUrl ?? '').trim() || null,
    citationKey: (canonical.rawCitationKey ?? '').trim()
      ? await disambiguateCitationKey(client, canonical.rawCitationKey!.trim(), { userId, projectId: effectiveProjectId })
      : null,
    metadata: metadataPayload as Prisma.InputJsonValue,
    hasFile, attachmentCount: attachmentsToCreate.length, noteCount: notes.length, firstAuthor,
    projectId: effectiveProjectId, version: 1,
    ...(uniqueCollectionIds.length > 0
      ? { collectionItems: { create: uniqueCollectionIds.map((cid, idx) => ({ collectionId: cid, sortOrder: idx })) } }
      : {}),
    ...(contributorsToCreate && contributorsToCreate.length > 0 ? { contributors: { create: contributorsToCreate } } : {}),
    ...(resolvedTags.length > 0 ? { itemTags: { create: resolvedTags.map(({ id, type }) => ({ tagId: id, type })) } } : {}),
    ...(attachmentsToCreate.length > 0 ? { attachments: { create: attachmentsToCreate } } : {}),
    ...(notes.length > 0 ? { notesList: { create: notes } } : {}),
  } as unknown as Prisma.ItemUncheckedCreateInput;

  return { createData, resolvedFileId, identifiersToCreate };
}

export function buildCommandUpdateInput(
  userId: string, existing: ItemDetail | Record<string, unknown>, data: UpdateItemData, options?: { skipVersionIncrement?: boolean },
): {
  updateData: Prisma.ItemUpdateInput;
  cleanIds: ReturnType<typeof normalizeItemIdentifiers>;
  rawTags?: (TagInput | null | undefined)[];
} {
  const dataRecord = data as Record<string, unknown>;
  if (typeof dataRecord.author === 'string' && dataRecord.author.trim() && data.creators === undefined && data.contributors === undefined && data.authors === undefined) {
    data = { ...data, authors: [dataRecord.author.trim()] };
  }

  const ids = normalizeItemIdentifiers(data, { preserveOnInvalid: true });
  const targetItemType = (data.itemType ?? data.type ?? existing.itemType ?? existing.type ?? 'journalArticle') as string;
  const rawTags = data.tags || data.keywords || data.labels;

  let existingMeta: Record<string, unknown> = {};
  if (existing.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata)) {
    existingMeta = existing.metadata as Record<string, unknown>;
  } else if (typeof existing.metadata === 'string' && existing.metadata.trim().startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(existing.metadata);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existingMeta = parsed as Record<string, unknown>;
    } catch {
      existingMeta = {};
    }
  }

  const existingRawExtra =
    typeof existing.extra === 'string' && existing.extra.trim()
      ? existing.extra.trim()
      : typeof existingMeta.extra === 'string' ? existingMeta.extra.trim() : '';

  const canonical = resolveCanonicalCommandFields(data, targetItemType, {});
  const cleanAbstract =
    canonical.rawAbstract !== undefined
      ? canonical.rawAbstract === null || canonical.rawAbstract.trim() === ''
        ? null
        : (cleanAbstractText(canonical.rawAbstract) ?? canonical.rawAbstract)
      : existing.abstract;

  const existingNoteList = existing.notesList || existing.notes;
  const existingProjectId =
    typeof (existing as Record<string, unknown>).projectId === 'string' ? ((existing as Record<string, unknown>).projectId as string) : null;
  const newNotesToCreate = prepareNotesToCreate(
    data.notes, userId, data.userId || (existing.uploadedById as string | undefined) || userId, existingNoteList, existingProjectId,
  );
  const newAttachmentsToCreate =
    Array.isArray(data.attachments) && data.attachments.length > 0
      ? prepareAttachmentsToCreate(data.attachments.filter((a: Record<string, unknown> | null | undefined) => !a?.id), null, undefined, userId)
      : [];

  const updatedMetadata = buildMetadataPartial({
    mode: 'update', baseMeta: existingMeta, data, canonical, ids, rawTags, existingRawExtra,
  });

  const existingContributorsList = (
    Array.isArray(existing.contributors) ? existing.contributors : Array.isArray(existing.creators) ? existing.creators : undefined
  ) as Array<Record<string, unknown>> | undefined;

  applyManualEditProvenanceLocks({
    existingMeta, dataRecord,
    dataExtra: {
      ...(canonical.effectiveExtraFields || {}),
      ...(data.extraFields && typeof data.extraFields === 'object' && !Array.isArray(data.extraFields) ? (data.extraFields as Record<string, unknown>) : {}),
    },
    updatedMetadata,
  });

  const existingItemType = (existing.itemType ?? existing.type ?? 'journalArticle') as string;
  if (existingItemType !== targetItemType) {
    const oldBaseMap = getEffectiveBaseFieldMap(existingItemType);
    const newBaseMap = canonical.baseMap;
    for (const [baseField, oldMappedKey] of Object.entries(oldBaseMap)) {
      const newMappedKey = newBaseMap[baseField];
      if (oldMappedKey && oldMappedKey !== newMappedKey) {
        if (newMappedKey && updatedMetadata[newMappedKey] === undefined && updatedMetadata[oldMappedKey] != null) {
          updatedMetadata[newMappedKey] = updatedMetadata[oldMappedKey];
        } else if (!newMappedKey && updatedMetadata[baseField] === undefined && updatedMetadata[oldMappedKey] != null) {
          updatedMetadata[baseField] = updatedMetadata[oldMappedKey];
        }
        delete updatedMetadata[oldMappedKey];
      }
    }
    if (targetItemType !== 'journalArticle') delete updatedMetadata.journal;
  }

  const oldPrimaryRole = getPrimaryCreatorRoleForType(existingItemType);
  const newPrimaryRole = getPrimaryCreatorRoleForType(targetItemType);
  const validTargetCreatorMap = getValidCreatorMapForType(targetItemType);
  const hasInvalidCreatorForTargetType =
    existingItemType !== targetItemType && validTargetCreatorMap.size > 0 && Array.isArray(existingContributorsList) &&
    existingContributorsList.some((c) => !validTargetCreatorMap.has(String(c.creatorType || c.role || 'author').trim().toLowerCase()));
  const shouldRemapExistingPrimaryRoles =
    existingItemType !== targetItemType && (oldPrimaryRole !== newPrimaryRole || hasInvalidCreatorForTargetType) &&
    data.creators === undefined && data.contributors === undefined && data.authors === undefined && data.editors === undefined &&
    Array.isArray(existingContributorsList) && existingContributorsList.length > 0;

  const effectiveUpdateDataForCreators = shouldRemapExistingPrimaryRoles
    ? {
        ...data,
        creators: existingContributorsList.map((c) => {
          const currentRole = String(c.creatorType || c.role || 'author').trim();
          const currentLower = currentRole.toLowerCase();
          const isRoleValid = validTargetCreatorMap.size === 0 || validTargetCreatorMap.has(currentLower);
          const remappedRole =
            currentRole === oldPrimaryRole || currentRole === 'author' || !isRoleValid
              ? newPrimaryRole
              : validTargetCreatorMap.get(currentLower) || currentRole;
          return { ...c, creatorType: remappedRole, role: remappedRole };
        }),
      }
    : data;

  const contributorsToUpdate = prepareContributorsToCreate(effectiveUpdateDataForCreators, targetItemType, existingContributorsList);
  const collectionItemsPatch = buildCollectionItemsUpdatePatch(data);

  const updateData: Prisma.ItemUpdateInput = {
    title: canonical.rawTitle !== undefined ? sanitizeItemTitle(canonical.rawTitle) || (existing.title as string) : (existing.title as string),
    itemType: targetItemType,
    ...(canonical.rawPubTitle !== undefined
      ? { publicationTitle: canonical.rawPubTitle === null || canonical.rawPubTitle.trim() === '' ? null : canonical.rawPubTitle.trim() }
      : {}),
    year: (data.year !== undefined &&
    !(canonical.rawPubDate !== undefined && canonical.extractedYear !== null && Number(data.year) === Number(existing.year))
      ? data.year === null || String(data.year).trim() === '' ? null : Number(data.year)
      : canonical.rawPubDate !== undefined ? canonical.extractedYear : existing.year) as number | null | undefined,
    doi: (ids.doi !== undefined ? ids.doi || null : existing.doi) as string | null | undefined,
    abstract: cleanAbstract as string | null | undefined,
    url: (canonical.rawUrl !== undefined ? canonical.rawUrl?.trim() || null : existing.url) as string | null | undefined,
    citationKey: (canonical.suppliedCitationKey !== undefined ? canonical.suppliedCitationKey : existing.citationKey) as string | null | undefined,
    metadata: updatedMetadata as Prisma.InputJsonValue,
    ...(contributorsToUpdate !== null
      ? { firstAuthor: deriveFirstAuthor({ contributors: contributorsToUpdate, itemType: targetItemType }) }
      : data.contributors !== undefined || data.creators !== undefined || data.authors !== undefined ||
          data.editors !== undefined || (data as Record<string, unknown>).author !== undefined
        ? { firstAuthor: deriveFirstAuthor({ ...data, itemType: targetItemType }) }
        : {}),
    ...(collectionItemsPatch ? { collectionItems: collectionItemsPatch } : {}),
    ...(contributorsToUpdate !== null ? { contributors: { deleteMany: {}, create: contributorsToUpdate } } : {}),
    ...(newNotesToCreate.length > 0
      ? {
          notesList: { create: newNotesToCreate },
          noteCount: (Array.isArray(existingNoteList) ? existingNoteList.length : typeof existing.noteCount === 'number' ? existing.noteCount : 0) + newNotesToCreate.length,
        }
      : {}),
    ...(newAttachmentsToCreate.length > 0
      ? {
          attachments: { create: newAttachmentsToCreate },
          attachmentCount: (Array.isArray(existing.attachments) ? existing.attachments.length : typeof existing.attachmentCount === 'number' ? existing.attachmentCount : 0) + newAttachmentsToCreate.length,
          hasFile: true,
        }
      : {}),
    ...(data.isRetracted !== undefined || data.retractionCheckedAt !== undefined
      ? {
          retractionCheckedAt:
            data.retractionCheckedAt === null && data.isRetracted === undefined
              ? null
              : data.retractionCheckedAt ? new Date(data.retractionCheckedAt as string | number | Date) : new Date(),
        }
      : {}),
    ...(options?.skipVersionIncrement ? {} : { version: { increment: 1 } }),
  };

  return { updateData, cleanIds: ids, rawTags };
}

export const buildUpdateItemPayload = buildCommandUpdateInput;
