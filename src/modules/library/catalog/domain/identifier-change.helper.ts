import { Prisma } from '@prisma/client';
import {
  normalizeDoi,
  normalizeArxivId,
  normalizePmid,
  normalizePmcid,
  normalizeIsbn,
  normalizeIssn,
  cleanBannedString,
  extractExtraKeyValues,
  isPlaceholderItemTitle,
  harmonizeZoteroFields,
  ItemProvenancePolicy,
} from '@/modules/library/core';
import { ITEM_COLUMN_METADATA_FIELDS } from '@/modules/library/catalog/types/catalog.types';
import { ItemDetail } from '@/modules/library/core/types/bibliographic.types';

export { extractExtraKeyValues, ITEM_COLUMN_METADATA_FIELDS };

const SAFE_PROVENANCE_AND_TELEMETRY_KEYS = [
  'isFilenameTitle', 'disambiguationWarning', 'rejectedCitedDoi',
  'promptUploadPdf', 'dismissedDuplicateIds', 'mergedFromIds',
] as const;

const TRANSIENT_AI_PATCH_ALIASES = [
  'DOI', 'ISBN', 'ISSN', 'PMID', 'PMCID', 'archiveID', 'citeKey', 'URL',
] as const;

export interface AiMetadataPatchPreparation {
  filteredPatch: Record<string, unknown>;
  topLevelColumnSync: Record<string, unknown>;
  mergedMetadata: Prisma.InputJsonValue;
}

export function prepareItemAiMetadataPatch(params: {
  existingTitle?: string | null;
  effectiveItemType: string;
  currentMeta: Record<string, unknown>;
  aiMetadataPatch: Record<string, unknown>;
}): AiMetadataPatchPreparation {
  const { existingTitle, effectiveItemType, currentMeta, aiMetadataPatch } = params;
  const rawPatch: Record<string, unknown> = { ...aiMetadataPatch };
  if (rawPatch.URL !== undefined && rawPatch.url === undefined) rawPatch.url = rawPatch.URL;
  delete rawPatch.citationKey;
  delete rawPatch.citeKey;
  delete rawPatch.mergedCitationKeys;

  const hasBibliographicFields = Object.keys(rawPatch).some(
    (k) => ITEM_COLUMN_METADATA_FIELDS.has(k) || ITEM_COLUMN_METADATA_FIELDS.has(k.toLowerCase()),
  );
  const sanitizedPatch = hasBibliographicFields
    ? harmonizeZoteroFields(rawPatch, {
        itemType: effectiveItemType,
        syncExtraFields: false,
        syncLegacyAliases: false,
      })
    : rawPatch;

  for (const transientAlias of TRANSIENT_AI_PATCH_ALIASES) delete sanitizedPatch[transientAlias];

  const { filteredPatch, updatedFieldProvenance } = ItemProvenancePolicy.filterAiMetadataPatch(
    currentMeta,
    sanitizedPatch,
  );

  const topLevelColumnSync: Record<string, unknown> = {};
  if (updatedFieldProvenance) {
    if (filteredPatch.year !== undefined) {
      const parsedYear =
        typeof filteredPatch.year === 'number'
          ? filteredPatch.year
          : parseInt(String(filteredPatch.year), 10);
      if (!Number.isNaN(parsedYear) && parsedYear >= 1000 && parsedYear <= 2999) {
        topLevelColumnSync.year = parsedYear;
      }
    }
    if (typeof filteredPatch.doi === 'string' && filteredPatch.doi.trim()) {
      topLevelColumnSync.doi = filteredPatch.doi.trim();
    }
    const resolvedAbstract =
      typeof filteredPatch.abstract === 'string' && filteredPatch.abstract.trim()
        ? filteredPatch.abstract.trim()
        : typeof filteredPatch.abstractNote === 'string' && filteredPatch.abstractNote.trim()
          ? filteredPatch.abstractNote.trim()
          : undefined;
    if (resolvedAbstract) topLevelColumnSync.abstract = resolvedAbstract;

    const resolvedVenue =
      typeof filteredPatch.publicationTitle === 'string' && filteredPatch.publicationTitle.trim()
        ? filteredPatch.publicationTitle.trim()
        : typeof filteredPatch.journal === 'string' && filteredPatch.journal.trim()
          ? filteredPatch.journal.trim()
          : typeof filteredPatch.venue === 'string' && filteredPatch.venue.trim()
            ? filteredPatch.venue.trim()
            : undefined;
    if (resolvedVenue) topLevelColumnSync.publicationTitle = resolvedVenue;

    if (typeof filteredPatch.url === 'string' && filteredPatch.url.trim()) {
      topLevelColumnSync.url = filteredPatch.url.trim();
    }
    const existingTitleStr = typeof existingTitle === 'string' ? existingTitle.trim() : '';
    const isExistingTitlePlaceholderOrFilename =
      isPlaceholderItemTitle(existingTitleStr) ||
      currentMeta.isFilenameTitle === true ||
      /\.(pdf|docx?|txt|pptx?|xlsx?)$/i.test(existingTitleStr) ||
      (existingTitleStr.includes('_') && !existingTitleStr.includes(' '));
    if (
      typeof filteredPatch.title === 'string' &&
      filteredPatch.title.trim() &&
      isExistingTitlePlaceholderOrFilename
    ) {
      topLevelColumnSync.title = filteredPatch.title.trim();
    }
  }

  const mergedMetadata = {
    ...currentMeta,
    ...filteredPatch,
    ...(updatedFieldProvenance ? { fieldProvenance: updatedFieldProvenance } : {}),
  } as Prisma.InputJsonValue;

  return { filteredPatch, topLevelColumnSync, mergedMetadata };
}

export function applyMetadataProvenanceAndTelemetry(
  result: Record<string, unknown>,
  dataRecord: Record<string, unknown>,
  dataExtra: Record<string, unknown>,
  options: { isCreate: boolean; rawTitle: string | undefined },
): void {
  for (const key of SAFE_PROVENANCE_AND_TELEMETRY_KEYS) {
    const val = dataRecord[key] !== undefined ? dataRecord[key] : dataExtra[key];
    if (val === null) delete result[key];
    else if (val !== undefined) result[key] = val;
  }
  const asPlainObj = (v: unknown): Record<string, unknown> =>
    v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const incomingProvTop = asPlainObj(dataRecord.fieldProvenance);
  const incomingProvExtra = asPlainObj(dataExtra.fieldProvenance);
  if (Object.keys(incomingProvTop).length > 0 || Object.keys(incomingProvExtra).length > 0) {
    result.fieldProvenance = {
      ...asPlainObj(result.fieldProvenance),
      ...incomingProvTop,
      ...incomingProvExtra,
    };
  }
  const hasExplicitLocksTop =
    Array.isArray(dataRecord.lockedFields) || dataRecord.lockedFields === null;
  const hasExplicitLocksExtra =
    Array.isArray(dataExtra.lockedFields) || dataExtra.lockedFields === null;
  if (hasExplicitLocksTop || hasExplicitLocksExtra) {
    const rawExplicitLocks = hasExplicitLocksTop
      ? Array.isArray(dataRecord.lockedFields) ? (dataRecord.lockedFields as unknown[]) : []
      : Array.isArray(dataExtra.lockedFields) ? (dataExtra.lockedFields as unknown[]) : [];
    const cleanedExplicitLocks = Array.from(
      new Set(
        rawExplicitLocks.filter((f): f is string => typeof f === 'string' && f.trim().length > 0),
      ),
    );
    const prevLocks = Array.isArray(result.lockedFields)
      ? (result.lockedFields as unknown[]).filter((f): f is string => typeof f === 'string')
      : [];
    const newLockSet = new Set(cleanedExplicitLocks);
    const unlockedFields = prevLocks.filter((f) => !newLockSet.has(f));
    if (unlockedFields.length > 0 && result.fieldProvenance && typeof result.fieldProvenance === 'object') {
      const nextProv = { ...asPlainObj(result.fieldProvenance) };
      for (const uf of unlockedFields) {
        const entry = asPlainObj(nextProv[uf]);
        if (entry.isUserOverride === true || entry.source === 'UserOverride') delete nextProv[uf];
      }
      result.fieldProvenance = nextProv;
    }
    result.lockedFields = cleanedExplicitLocks;
  }
  if (
    !options.isCreate &&
    options.rawTitle !== undefined &&
    !isPlaceholderItemTitle(options.rawTitle) &&
    dataRecord.isFilenameTitle === undefined &&
    dataExtra.isFilenameTitle === undefined &&
    result.isFilenameTitle === true
  ) {
    result.isFilenameTitle = false;
    const provMap = asPlainObj(result.fieldProvenance);
    if (provMap.title && typeof provMap.title === 'object') {
      result.fieldProvenance = {
        ...provMap,
        title: { ...(provMap.title as Record<string, unknown>), isFilenameTitle: false },
      };
    }
  }
}

export function cleanSingleIdentifier(
  raw: string | null | undefined,
  normalizer: (val?: string | null) => string | undefined,
  options?: { preserveOnInvalid?: boolean },
): string | undefined {
  if (raw === undefined) return undefined;
  if (!raw) return '';
  const cleaned = cleanBannedString(raw);
  if (!cleaned) return '';
  const normalized = normalizer(cleaned);
  if (normalized !== undefined) return normalized;
  return options?.preserveOnInvalid ? undefined : '';
}

export function normalizeItemIdentifiers(
  data: {
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
    identifiers?: ReadonlyArray<{ type: string; value: string; canonicalUri?: string | null }> | null;
  },
  options?: { preserveOnInvalid?: boolean },
) {
  const rec = data as Record<string, unknown>;
  const ef = data.extraFields && typeof data.extraFields === 'object' ? data.extraFields : {};
  const extraKv = extractExtraKeyValues(data.extra);
  const explicitByType: Record<string, string> = {};
  if (Array.isArray(data.identifiers)) {
    for (const ident of data.identifiers) {
      if (ident && typeof ident.type === 'string' && typeof ident.value === 'string' && ident.value.trim()) {
        const t = ident.type.trim().toLowerCase();
        if (!explicitByType[t]) explicitByType[t] = ident.value.trim();
      }
    }
  }
  const isStaleExtraEcho = (val: string, extraKvKeys: string[]): boolean => {
    const trimmed = val.trim();
    return extraKvKeys.some((ek) => extraKv[ek] !== undefined && extraKv[ek].trim() === trimmed);
  };
  const pickFirst = (keys: string[], extraKvKeys: string[]): string | null | undefined => {
    let sawTopNull = false;
    let sawTopEmpty = false;
    for (const k of keys) {
      const v = rec[k];
      if (v === undefined) continue;
      if (v === null) { sawTopNull = true; continue; }
      if (typeof v === 'string') {
        if (v.trim() !== '') return v;
        sawTopEmpty = true;
        continue;
      }
      if (typeof v === 'number') return String(v);
    }
    if (sawTopNull) return null;

    let sawEfNull = false;
    let sawEfEmpty = false;
    for (const k of keys) {
      const v = ef[k];
      if (v === undefined) continue;
      if (v === null) { sawEfNull = true; continue; }
      if (typeof v === 'string') {
        if (v.trim() !== '') {
          if ((sawTopEmpty || sawTopNull) && isStaleExtraEcho(v, extraKvKeys)) continue;
          return v;
        }
        sawEfEmpty = true;
        continue;
      }
      if (typeof v === 'number') return String(v);
    }
    if (sawTopEmpty || sawTopNull) {
      for (const ek of extraKvKeys) {
        const expVal = explicitByType[ek];
        if (expVal && !isStaleExtraEcho(expVal, extraKvKeys)) return expVal;
      }
      return sawTopNull ? null : '';
    }
    if (sawEfNull) return null;
    if (sawEfEmpty) return '';

    for (const ek of extraKvKeys) {
      if (extraKv[ek] !== undefined && extraKv[ek].trim() !== '') return extraKv[ek];
      if (explicitByType[ek] !== undefined && explicitByType[ek].trim() !== '') return explicitByType[ek];
    }
    return undefined;
  };
  return {
    doi: cleanSingleIdentifier(pickFirst(['doi', 'DOI'], ['doi']), normalizeDoi, options),
    arxivId: cleanSingleIdentifier(pickFirst(['arxivId', 'archiveID', 'archiveId'], ['arxiv', 'arxivid', 'arxiv-id']), normalizeArxivId, options),
    pmid: cleanSingleIdentifier(pickFirst(['pmid', 'PMID'], ['pmid']), normalizePmid, options),
    pmcid: cleanSingleIdentifier(pickFirst(['pmcid', 'PMCID'], ['pmcid', 'pmc']), normalizePmcid, options),
    isbn: cleanSingleIdentifier(pickFirst(['isbn', 'ISBN'], ['isbn']), normalizeIsbn, options),
    issn: cleanSingleIdentifier(pickFirst(['issn', 'ISSN'], ['issn']), normalizeIssn, options),
  };
}

export const IDENTIFIER_URI_BUILDERS: ReadonlyArray<{
  type: 'doi' | 'arxiv' | 'pmid' | 'pmcid' | 'isbn' | 'issn';
  key: keyof ReturnType<typeof normalizeItemIdentifiers>;
  buildUri: (val: string) => string;
}> = [
  { type: 'doi', key: 'doi', buildUri: (v) => `https://doi.org/${v}` },
  { type: 'arxiv', key: 'arxivId', buildUri: (v) => `https://arxiv.org/abs/${v}` },
  { type: 'pmid', key: 'pmid', buildUri: (v) => `https://pubmed.ncbi.nlm.nih.gov/${v}/` },
  { type: 'pmcid', key: 'pmcid', buildUri: (v) => `https://www.ncbi.nlm.nih.gov/pmc/articles/${v}/` },
  { type: 'isbn', key: 'isbn', buildUri: (v) => `urn:isbn:${v}` },
  { type: 'issn', key: 'issn', buildUri: (v) => `urn:issn:${v}` },
];

export function buildDeduplicatedIdentifiers(
  cleanIds: ReturnType<typeof normalizeItemIdentifiers>,
  explicitIdentifiers?: ReadonlyArray<{ type: string; value: string; canonicalUri?: string | null }> | null,
): Array<{ type: string; value: string; canonicalUri: string | null }> {
  const seenTypes = new Set<string>();
  const seenPairs = new Set<string>();
  const result: Array<{ type: string; value: string; canonicalUri: string | null }> = [];

  for (const { type, key, buildUri } of IDENTIFIER_URI_BUILDERS) {
    const val = cleanIds[key];
    if (val && val.trim()) {
      const trimmed = val.trim();
      seenTypes.add(type);
      seenPairs.add(`${type}::${trimmed.toLowerCase()}`);
      result.push({ type, value: trimmed, canonicalUri: buildUri(trimmed) });
    }
  }
  if (Array.isArray(explicitIdentifiers)) {
    for (const ident of explicitIdentifiers) {
      if (!ident || typeof ident.type !== 'string' || typeof ident.value !== 'string') continue;
      const type = ident.type.trim().toLowerCase();
      const value = ident.value.trim();
      if (!type || !value) continue;
      const pairKey = `${type}::${value.toLowerCase()}`;
      if (seenTypes.has(type) || seenPairs.has(pairKey)) continue;
      seenTypes.add(type);
      seenPairs.add(pairKey);
      const uriBuilder = IDENTIFIER_URI_BUILDERS.find((b) => b.type === type)?.buildUri;
      result.push({ type, value, canonicalUri: ident.canonicalUri ?? (uriBuilder ? uriBuilder(value) : null) });
    }
  }
  return result;
}

export function calculateIdentifierChanges(
  cleanIds: Partial<Record<keyof ReturnType<typeof normalizeItemIdentifiers>, string | null | undefined>>,
  existing: ItemDetail | Record<string, unknown>,
  explicitIdentifiers?: ReadonlyArray<{ type: string; value: string | null; canonicalUri?: string | null }> | null,
): Array<{ type: string; value: string; canonicalUri: string }> {
  const existingIdentifiers = Array.isArray(existing.identifiers)
    ? (existing.identifiers as Array<{ type?: string; value?: string; canonicalUri?: string | null }>)
    : undefined;
  const existingMeta =
    existing.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata)
      ? (existing.metadata as Record<string, unknown>)
      : {};

  const changes: Array<{ type: string; value: string; canonicalUri: string }> = [];
  const handledTypes = new Set<string>();
  for (const { type, key, buildUri } of IDENTIFIER_URI_BUILDERS) {
    handledTypes.add(type);
    if (!(key in cleanIds)) continue;
    const rawNewVal = cleanIds[key];
    if (rawNewVal === undefined) continue;
    const newVal = rawNewVal === null ? '' : rawNewVal;

    const fromRelation = existingIdentifiers?.find((item) => (item.type || '').toLowerCase() === type)?.value;
    const fromTop =
      typeof existing[key] === 'string' && (existing[key] as string).trim() ? (existing[key] as string).trim() : undefined;
    const fromMeta =
      typeof existingMeta[key] === 'string' && (existingMeta[key] as string).trim()
        ? (existingMeta[key] as string).trim()
        : type === 'arxiv' && typeof existingMeta.archiveID === 'string' && existingMeta.archiveID.trim()
          ? existingMeta.archiveID.replace(/^arxiv:\s*/i, '').trim()
          : undefined;
    const currentVal = fromRelation ?? fromTop ?? fromMeta;

    if (newVal === '') {
      if ((currentVal !== undefined && currentVal !== '') || existingIdentifiers === undefined) {
        changes.push({ type, value: '', canonicalUri: '' });
      }
    } else if (newVal !== currentVal) {
      changes.push({ type, value: newVal, canonicalUri: buildUri(newVal) });
    }
  }

  if (Array.isArray(explicitIdentifiers)) {
    const seenExplicitTypes = new Set<string>();
    for (const ident of explicitIdentifiers) {
      if (!ident || typeof ident.type !== 'string' || (typeof ident.value !== 'string' && ident.value !== null)) {
        continue;
      }
      const type = ident.type.trim().toLowerCase();
      if (!type || handledTypes.has(type) || seenExplicitTypes.has(type)) continue;
      seenExplicitTypes.add(type);
      const value = ident.value === null ? '' : ident.value.trim();
      const existingEntry = existingIdentifiers?.find((item) => (item.type || '').trim().toLowerCase() === type);
      const currentVal = existingEntry?.value?.trim();
      const currentUri = existingEntry?.canonicalUri ?? '';
      const nextUri = ident.canonicalUri?.trim() || '';

      if (!value) {
        if (currentVal || existingIdentifiers === undefined) changes.push({ type, value: '', canonicalUri: '' });
      } else if (value !== currentVal || (nextUri && nextUri !== currentUri)) {
        changes.push({ type, value, canonicalUri: nextUri });
      }
    }
  }
  return changes;
}

export function buildMyPublicationMetadata(
  existingMetadata: unknown,
  isMyPublication: boolean,
  options?: {
    contributorId?: string | null;
    isPublic?: boolean;
    openAccessLicense?: string | null;
    includeAttachments?: boolean;
    includeNotes?: boolean;
    authorshipConfirmed?: boolean;
    stripSharedFlag?: boolean;
  },
): Record<string, unknown> {
  const metadataObj: Record<string, unknown> =
    typeof existingMetadata === 'object' && existingMetadata !== null && !Array.isArray(existingMetadata)
      ? { ...(existingMetadata as Record<string, unknown>) }
      : {};
  const clearKeys = [
    'myPublicationDetails', 'publicationConfirmedAt', 'openAccessLicense', 'isPublicPublication',
    'publicationContributorId', 'includeAttachmentsInMyPublications', 'includeNotesInMyPublications', 'authorshipConfirmed',
  ];
  if (options?.stripSharedFlag) {
    delete metadataObj.isMyPublication;
    for (const k of clearKeys) delete metadataObj[k];
    return metadataObj;
  }
  metadataObj.isMyPublication = isMyPublication;
  if (isMyPublication) {
    metadataObj.publicationConfirmedAt = new Date().toISOString();
    if (options?.openAccessLicense !== undefined) metadataObj.openAccessLicense = options.openAccessLicense;
    if (options?.isPublic !== undefined) metadataObj.isPublicPublication = options.isPublic;
    if (options?.contributorId !== undefined) metadataObj.publicationContributorId = options.contributorId;
    if (options?.includeAttachments !== undefined) metadataObj.includeAttachmentsInMyPublications = options.includeAttachments;
    if (options?.includeNotes !== undefined) metadataObj.includeNotesInMyPublications = options.includeNotes;
    if (options?.authorshipConfirmed !== undefined) metadataObj.authorshipConfirmed = options.authorshipConfirmed;
  } else {
    metadataObj.isMyPublication = false;
    for (const k of clearKeys) delete metadataObj[k];
  }
  return metadataObj;
}

export function buildCollectionItemsUpdatePatch(data: {
  collectionIds?: string[] | null;
  collections?: string[] | null;
  collectionId?: string | null;
}): Prisma.CollectionItemUpdateManyWithoutItemNestedInput | undefined {
  const effectiveArray = data.collectionIds !== undefined ? data.collectionIds : data.collections;
  if (effectiveArray !== undefined) {
    const unique = Array.from(
      new Set((Array.isArray(effectiveArray) ? effectiveArray : []).filter((cid): cid is string => typeof cid === 'string' && cid.trim().length > 0)),
    );
    return unique.length > 0
      ? { deleteMany: {}, create: unique.map((cid, idx) => ({ collection: { connect: { id: cid } }, sortOrder: idx })) }
      : { deleteMany: {} };
  }
  if (data.collectionId !== undefined) {
    return data.collectionId && typeof data.collectionId === 'string' && data.collectionId.trim().length > 0
      ? { deleteMany: {}, create: { collection: { connect: { id: data.collectionId.trim() } }, sortOrder: 0 } }
      : { deleteMany: {} };
  }
  return undefined;
}

const IDENTIFIER_EXTRA_CLEANUP_RULES: ReadonlyArray<{
  key: keyof ReturnType<typeof normalizeItemIdentifiers>;
  lineRe: RegExp;
  braceRe: RegExp;
}> = [
  { key: 'doi', lineRe: /^\s*doi\s*:/i, braceRe: /\{\s*:DOI:\s*[^}]*\}/gi },
  { key: 'isbn', lineRe: /^\s*isbn\s*:/i, braceRe: /\{\s*:ISBN:\s*[^}]*\}/gi },
  { key: 'issn', lineRe: /^\s*issn\s*:/i, braceRe: /\{\s*:ISSN:\s*[^}]*\}/gi },
  { key: 'pmid', lineRe: /^\s*pmid\s*:/i, braceRe: /\{\s*:PMID:\s*[^}]*\}/gi },
  { key: 'pmcid', lineRe: /^\s*(?:pmcid|pmc)\s*:/i, braceRe: /\{\s*:PMCID:\s*[^}]*\}/gi },
  { key: 'arxivId', lineRe: /^\s*(?:arxiv|arxivid|arxiv-id|archiveid)\s*:/i, braceRe: /\{\s*:(?:arxiv|archiveid)\s*:\s*[^}]*\}/gi },
];

export function syncMetadataIdentifierAliases(
  result: Record<string, unknown>,
  ids: ReturnType<typeof normalizeItemIdentifiers>,
  options?: {
    isCreate?: boolean;
    itemType?: string;
    rawPubTitle?: string | null;
    rawPublisher?: string | null;
    rawPlace?: string | null;
    rawVolume?: string | number | null;
    rawIssue?: string | number | null;
    rawPages?: string | number | null;
    rawAbstract?: string | null;
    rawUrl?: string | null;
    suppliedCitationKey?: string | null;
    year?: number | string | null;
    rawPubDate?: string | null;
    rawTypeField?: string | null;
    mappedTypeKey?: string;
    baseMap?: Record<string, string>;
    dataRecord?: Record<string, unknown>;
  },
): void {
  const isCreate = Boolean(options?.isCreate);
  for (const upperKey of ['DOI', 'ISBN', 'ISSN', 'PMID', 'ARXIV', 'PMCID']) delete result[upperKey];
  const syncKey = (val: string | null | undefined, primary: string, aliases: string[]) => {
    if (val === undefined) return;
    result[primary] = val === null || val === '' ? (isCreate ? '' : null) : val;
    for (const a of aliases) delete result[a];
  };
  syncKey(ids.doi, 'doi', ['DOI']);
  syncKey(ids.isbn, 'isbn', ['ISBN']);
  syncKey(ids.issn, 'issn', ['ISSN']);
  syncKey(ids.pmid, 'pmid', ['PMID']);
  syncKey(ids.pmcid, 'pmcid', ['PMCID']);
  syncKey(ids.arxivId, 'arxivId', ['archiveId', 'archiveID', 'ARXIV', 'arxiv']);

  if (!isCreate && typeof result.extra === 'string' && result.extra) {
    const clearedLinePatterns: RegExp[] = [];
    const clearedBracePatterns: RegExp[] = [];
    for (const rule of IDENTIFIER_EXTRA_CLEANUP_RULES) {
      if (ids[rule.key] !== undefined) {
        clearedLinePatterns.push(rule.lineRe);
        clearedBracePatterns.push(rule.braceRe);
      }
    }
    if (options?.suppliedCitationKey !== undefined) {
      clearedLinePatterns.push(/^\s*(?:citation[\s_-]*key|cite[\s_-]*key|bibtex)\s*:/i);
    }
    if (clearedLinePatterns.length > 0 || clearedBracePatterns.length > 0) {
      let cleanedExtra = result.extra;
      for (const braceRe of clearedBracePatterns) cleanedExtra = cleanedExtra.replace(braceRe, '');
      result.extra = cleanedExtra
        .split(/\r?\n/)
        .filter((line) => !clearedLinePatterns.some((re) => re.test(line)))
        .join('\n')
        .trim();
    }
  }
  if (!isCreate) {
    const clearMappedField = (baseField: string, rawVal: unknown, extraAliases: string[] = []) => {
      if (rawVal === null || (typeof rawVal === 'string' && rawVal.trim() === '')) {
        result[baseField] = null;
        const mapped = options?.baseMap?.[baseField];
        if (mapped && mapped !== baseField) delete result[mapped];
        for (const alias of extraAliases) delete result[alias];
      }
    };
    clearMappedField('publisher', options?.rawPublisher);
    clearMappedField('place', options?.rawPlace);
    clearMappedField('volume', options?.rawVolume);
    clearMappedField('issue', options?.rawIssue, ['number', ...(options?.baseMap?.number ? [options.baseMap.number] : [])]);
    clearMappedField('pages', options?.rawPages);
    if (options?.rawPubDate === null || (typeof options?.rawPubDate === 'string' && options.rawPubDate.trim() === '')) {
      result.date = null;
      result.publicationDate = null;
      if (options?.baseMap?.date) delete result[options.baseMap.date];
    }
    if (options?.rawPubTitle !== undefined) {
      if (options.rawPubTitle === null || options.rawPubTitle.trim() === '') {
        result.publicationTitle = null;
        for (const alias of [
          'journal', 'proceedingsTitle', 'bookTitle', 'websiteTitle',
          'blogTitle', 'forumTitle', 'dictionaryTitle', 'encyclopediaTitle', 'programTitle',
          'reporter', 'code', 'repository', 'venue', 'sessionTitle',
        ]) {
          delete result[alias];
        }
      } else {
        const trimmedPub = options.rawPubTitle.trim();
        const mappedPubKey = options.baseMap?.publicationTitle;
        if (mappedPubKey && options.dataRecord?.[mappedPubKey] === undefined) result[mappedPubKey] = trimmedPub;
        if (options.itemType === 'journalArticle') result.journal = trimmedPub;
        else delete result.journal;
        delete result.venue;
      }
    }
    if (options?.rawAbstract !== undefined) {
      if (options.rawAbstract === null || options.rawAbstract.trim() === '') result.abstractNote = null;
      delete result.abstract;
    }
    if (options?.rawUrl !== undefined) {
      if (options.rawUrl === null || options.rawUrl.trim() === '') delete result.url;
      else result.url = options.rawUrl.trim();
      delete result.URL;
    }
    if (options?.suppliedCitationKey !== undefined) {
      if (options.suppliedCitationKey === null || options.suppliedCitationKey.trim() === '') delete result.citationKey;
      else result.citationKey = options.suppliedCitationKey.trim();
      delete result.citeKey;
    }
    const mappedDateKey = options?.baseMap?.date;
    if (options?.rawPubDate === undefined && options?.year !== undefined) {
      if (options.year === null || String(options.year).trim() === '') {
        result.date = null;
        result.publicationDate = null;
        if (mappedDateKey) delete result[mappedDateKey];
      } else {
        const yearStr = String(options.year).trim();
        const existingDate = String(result.date ?? result.publicationDate ?? '').trim();
        if (!existingDate || /^\d{4}$/.test(existingDate)) {
          result.date = yearStr;
          result.publicationDate = yearStr;
          if (mappedDateKey) result[mappedDateKey] = yearStr;
        } else if (/^\d{4}$/.test(yearStr) && /(?:^|[^\d])(1\d{3}|20\d{2})(?:[^\d]|$)/.test(existingDate)) {
          const updatedDate = existingDate.replace(/(1\d{3}|20\d{2})/, yearStr);
          result.date = updatedDate;
          result.publicationDate = updatedDate;
          if (mappedDateKey) result[mappedDateKey] = updatedDate;
        }
      }
    }
    if (options?.rawTypeField === null) {
      result.type = null;
      if (options.mappedTypeKey) delete result[options.mappedTypeKey];
    } else if (typeof options?.rawTypeField === 'string' && options.rawTypeField.trim() && options.mappedTypeKey) {
      result[options.mappedTypeKey] = options.rawTypeField.trim();
    }
  }
}
