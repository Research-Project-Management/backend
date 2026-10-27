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
} from '@/modules/library/core';
import { ItemDetail } from '@/modules/library/core/types/bibliographic.types';

export { extractExtraKeyValues };

const SAFE_PROVENANCE_AND_TELEMETRY_KEYS = [
  'isFilenameTitle',
  'disambiguationWarning',
  'rejectedCitedDoi',
  'promptUploadPdf',
  'dismissedDuplicateIds',
  'mergedFromIds',
] as const;

export function applyMetadataProvenanceAndTelemetry(
  result: Record<string, unknown>,
  dataRecord: Record<string, unknown>,
  dataExtra: Record<string, unknown>,
  options: { isCreate: boolean; rawTitle: string | undefined },
): void {
  for (const key of SAFE_PROVENANCE_AND_TELEMETRY_KEYS) {
    const val = dataRecord[key] !== undefined ? dataRecord[key] : dataExtra[key];
    if (val === null) {
      delete result[key];
    } else if (val !== undefined) {
      result[key] = val;
    }
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
  const incomingLocksTop = Array.isArray(dataRecord.lockedFields) ? (dataRecord.lockedFields as unknown[]) : [];
  const incomingLocksExtra = Array.isArray(dataExtra.lockedFields) ? (dataExtra.lockedFields as unknown[]) : [];
  if (incomingLocksTop.length > 0 || incomingLocksExtra.length > 0) {
    const existingLocks = Array.isArray(result.lockedFields) ? (result.lockedFields as unknown[]) : [];
    const mergedLocks = Array.from(
      new Set(
        [...existingLocks, ...incomingLocksTop, ...incomingLocksExtra].filter(
          (f): f is string => typeof f === 'string' && f.trim().length > 0,
        ),
      ),
    );
    if (mergedLocks.length > 0) {
      result.lockedFields = mergedLocks;
    }
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
): string | undefined {
  if (raw === undefined) return undefined;
  if (!raw) return '';
  const cleaned = cleanBannedString(raw);
  return normalizer(cleaned) || cleaned || '';
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
  identifiers?: ReadonlyArray<{
    type: string;
    value: string;
    canonicalUri?: string | null;
  }> | null;
}) {
  const rec = data as Record<string, unknown>;
  const ef =
    data.extraFields && typeof data.extraFields === 'object'
      ? data.extraFields
      : {};
  const extraKv = extractExtraKeyValues(data.extra);
  const explicitByType: Record<string, string> = {};
  if (Array.isArray(data.identifiers)) {
    for (const ident of data.identifiers) {
      if (
        ident &&
        typeof ident.type === 'string' &&
        typeof ident.value === 'string' &&
        ident.value.trim()
      ) {
        const t = ident.type.trim().toLowerCase();
        if (!explicitByType[t]) {
          explicitByType[t] = ident.value.trim();
        }
      }
    }
  }
  const pickFirst = (
    keys: string[],
    extraKvKeys: string[],
  ): string | null | undefined => {
    let sawNull = false;
    let sawEmptyString = false;

    for (const k of keys) {
      const v = rec[k] !== undefined ? rec[k] : ef[k];
      if (v === undefined) continue;
      if (v === null) {
        sawNull = true;
        continue;
      }
      if (typeof v === 'string') {
        if (v.trim() !== '') return v;
        sawEmptyString = true;
        continue;
      }
      if (typeof v === 'number') return String(v);
    }
    for (const ek of extraKvKeys) {
      if (extraKv[ek] !== undefined && extraKv[ek].trim() !== '') {
        return extraKv[ek];
      }
      if (explicitByType[ek] !== undefined && explicitByType[ek].trim() !== '') {
        return explicitByType[ek];
      }
    }
    if (sawNull) return null;
    if (sawEmptyString) return '';
    return undefined;
  };
  return {
    doi: cleanSingleIdentifier(pickFirst(['doi', 'DOI'], ['doi']), normalizeDoi),
    arxivId: cleanSingleIdentifier(
      pickFirst(['arxivId', 'archiveID', 'archiveId'], ['arxiv', 'arxivid', 'arxiv-id']),
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

export function buildDeduplicatedIdentifiers(
  cleanIds: ReturnType<typeof normalizeItemIdentifiers>,
  explicitIdentifiers?: ReadonlyArray<{
    type: string;
    value: string;
    canonicalUri?: string | null;
  }> | null,
): Array<{ type: string; value: string; canonicalUri: string | null }> {
  const seenTypes = new Set<string>();
  const seenPairs = new Set<string>();
  const result: Array<{
    type: string;
    value: string;
    canonicalUri: string | null;
  }> = [];

  for (const { type, key, buildUri } of IDENTIFIER_URI_BUILDERS) {
    const val = cleanIds[key];
    if (val && val.trim()) {
      const trimmed = val.trim();
      const pairKey = `${type}::${trimmed.toLowerCase()}`;
      seenTypes.add(type);
      seenPairs.add(pairKey);
      result.push({
        type,
        value: trimmed,
        canonicalUri: buildUri(trimmed),
      });
    }
  }

  if (Array.isArray(explicitIdentifiers)) {
    for (const ident of explicitIdentifiers) {
      if (
        !ident ||
        typeof ident.type !== 'string' ||
        typeof ident.value !== 'string'
      ) {
        continue;
      }
      const type = ident.type.trim().toLowerCase();
      const value = ident.value.trim();
      if (!type || !value) continue;
      const pairKey = `${type}::${value.toLowerCase()}`;
      if (seenTypes.has(type) || seenPairs.has(pairKey)) continue;
      seenTypes.add(type);
      seenPairs.add(pairKey);
      const uriBuilder = IDENTIFIER_URI_BUILDERS.find(
        (b) => b.type === type,
      )?.buildUri;
      result.push({
        type,
        value,
        canonicalUri:
          ident.canonicalUri ?? (uriBuilder ? uriBuilder(value) : null),
      });
    }
  }

  return result;
}

export function calculateIdentifierChanges(
  cleanIds: ReturnType<typeof normalizeItemIdentifiers>,
  existing: ItemDetail | Record<string, unknown>,
): Array<{ type: string; value: string; canonicalUri: string }> {
  const existingIdentifiers = Array.isArray(existing.identifiers)
    ? (existing.identifiers as Array<{ type?: string; value?: string }>)
    : undefined;
  const existingMeta =
    existing.metadata &&
    typeof existing.metadata === 'object' &&
    !Array.isArray(existing.metadata)
      ? (existing.metadata as Record<string, unknown>)
      : {};

  const changes: Array<{ type: string; value: string; canonicalUri: string }> =
    [];
  for (const { type, key, buildUri } of IDENTIFIER_URI_BUILDERS) {
    const newVal = cleanIds[key];
    if (newVal === undefined) continue;

    const fromRelation = existingIdentifiers?.find(
      (item) => (item.type || '').toLowerCase() === type,
    )?.value;
    const fromTop =
      typeof existing[key] === 'string' && (existing[key] as string).trim()
        ? (existing[key] as string).trim()
        : undefined;
    const fromMeta =
      typeof existingMeta[key] === 'string' &&
      (existingMeta[key] as string).trim()
        ? (existingMeta[key] as string).trim()
        : type === 'arxiv' &&
            typeof existingMeta.archiveID === 'string' &&
            existingMeta.archiveID.trim()
          ? existingMeta.archiveID.replace(/^arxiv:\s*/i, '').trim()
          : undefined;
    const currentVal = fromRelation ?? fromTop ?? fromMeta;

    if (newVal === '') {
      if (
        (currentVal !== undefined && currentVal !== '') ||
        existingIdentifiers === undefined
      ) {
        changes.push({
          type,
          value: '',
          canonicalUri: '',
        });
      }
    } else if (newVal !== currentVal) {
      changes.push({
        type,
        value: newVal,
        canonicalUri: buildUri(newVal),
      });
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
  },
): Record<string, unknown> {
  const metadataObj: Record<string, unknown> =
    typeof existingMetadata === 'object' &&
    existingMetadata !== null &&
    !Array.isArray(existingMetadata)
      ? { ...(existingMetadata as Record<string, unknown>) }
      : {};
  metadataObj.isMyPublication = isMyPublication;
  if (isMyPublication) {
    metadataObj.publicationConfirmedAt = new Date().toISOString();
    if (options?.openAccessLicense !== undefined) {
      metadataObj.openAccessLicense = options.openAccessLicense;
    }
    if (options?.isPublic !== undefined) {
      metadataObj.isPublicPublication = options.isPublic;
    }
    if (options?.contributorId !== undefined) {
      metadataObj.publicationContributorId = options.contributorId;
    }
    if (options?.includeAttachments !== undefined) {
      metadataObj.includeAttachmentsInMyPublications =
        options.includeAttachments;
    }
    if (options?.includeNotes !== undefined) {
      metadataObj.includeNotesInMyPublications = options.includeNotes;
    }
    if (options?.authorshipConfirmed !== undefined) {
      metadataObj.authorshipConfirmed = options.authorshipConfirmed;
    }
  } else {
    metadataObj.isMyPublication = false;
    delete metadataObj.publicationConfirmedAt;
    delete metadataObj.openAccessLicense;
    delete metadataObj.isPublicPublication;
    delete metadataObj.publicationContributorId;
    delete metadataObj.includeAttachmentsInMyPublications;
    delete metadataObj.includeNotesInMyPublications;
    delete metadataObj.authorshipConfirmed;
  }
  return metadataObj;
}

export function buildCollectionItemsUpdatePatch(data: { collectionIds?: string[] | null; collectionId?: string | null }): Prisma.CollectionItemUpdateManyWithoutItemNestedInput | undefined {
  if (data.collectionIds !== undefined) {
    const unique = Array.from(new Set((Array.isArray(data.collectionIds) ? data.collectionIds : []).filter((cid): cid is string => typeof cid === 'string' && cid.trim().length > 0)));
    return unique.length > 0 ? { deleteMany: {}, create: unique.map((cid, idx) => ({ collection: { connect: { id: cid } }, sortOrder: idx })) } : { deleteMany: {} };
  }
  if (data.collectionId !== undefined) {
    return data.collectionId && typeof data.collectionId === 'string' && data.collectionId.trim().length > 0 ? { deleteMany: {}, create: { collection: { connect: { id: data.collectionId.trim() } }, sortOrder: 0 } } : { deleteMany: {} };
  }
  return undefined;
}

export function syncMetadataIdentifierAliases(
  result: Record<string, unknown>,
  ids: ReturnType<typeof normalizeItemIdentifiers>,
  options?: {
    isCreate?: boolean;
    rawPubTitle?: string | null;
    rawAbstract?: string | null;
    year?: number | string | null;
    rawPubDate?: string | null;
    rawTypeField?: string | null;
    mappedTypeKey?: string;
  },
): void {
  const isCreate = Boolean(options?.isCreate);
  const syncKey = (
    val: string | null | undefined,
    primary: string,
    aliases: string[],
  ) => {
    if (val === undefined) return;
    if (val === null || val === '') {
      result[primary] = isCreate ? '' : null;
      for (const a of aliases) delete result[a];
    } else {
      result[primary] = val;
      for (const a of aliases) delete result[a];
    }
  };
  syncKey(ids.doi, 'doi', ['DOI']);
  syncKey(ids.isbn, 'isbn', ['ISBN']);
  syncKey(ids.issn, 'issn', ['ISSN']);
  syncKey(ids.pmid, 'pmid', ['PMID']);
  syncKey(ids.pmcid, 'pmcid', ['PMCID']);
  syncKey(ids.arxivId, 'arxivId', ['archiveId', 'archiveID']);
  if (
    (ids.arxivId === '' || ids.arxivId === null) &&
    typeof result.extra === 'string' &&
    result.extra
  ) {
    result.extra = result.extra
      .split(/\r?\n/)
      .filter((line) => !/^\s*(?:arxiv|arxivid)\s*:/i.test(line))
      .join('\n')
      .trim();
  }
  if (!isCreate) {
    if (options?.rawPubTitle !== undefined && (options.rawPubTitle === null || options.rawPubTitle.trim() === '')) {
      result.publicationTitle = null;
      for (const alias of [
        'journal', 'proceedingsTitle', 'bookTitle', 'websiteTitle',
        'blogTitle', 'forumTitle', 'dictionaryTitle', 'encyclopediaTitle', 'programTitle',
      ]) {
        delete result[alias];
      }
    }
    if (options?.rawAbstract !== undefined && (options.rawAbstract === null || options.rawAbstract.trim() === '')) {
      result.abstractNote = null;
      delete result.abstract;
    }
    if (options?.rawPubDate === undefined && options?.year !== undefined) {
      if (options.year === null || String(options.year).trim() === '') {
        result.date = null;
        result.publicationDate = null;
      } else {
        const yearStr = String(options.year).trim();
        const existingDate = String(result.date ?? result.publicationDate ?? '').trim();
        if (!existingDate || /^\d{4}$/.test(existingDate)) {
          result.date = yearStr;
          result.publicationDate = yearStr;
        }
      }
    }
    if (options?.rawTypeField === null) {
      result.type = null;
      if (options.mappedTypeKey) {
        delete result[options.mappedTypeKey];
      }
    }
  }
}

export async function syncCreatedIdentifiers(
  client: {
    itemIdentifier?: {
      upsert?: (args: unknown) => Promise<unknown>;
      createMany?: (args: unknown) => Promise<unknown>;
    };
  },
  itemId: string,
  identifiers: ReadonlyArray<{
    type: string;
    value: string;
    canonicalUri?: string | null;
  }>,
): Promise<void> {
  if (!client.itemIdentifier || identifiers.length === 0) return;
  const validIdentifiers = identifiers.filter((ident) => Boolean(ident.value));
  await Promise.all(
    validIdentifiers.map((ident) =>
      client.itemIdentifier?.upsert?.({
        where: { itemId_type: { itemId, type: ident.type } },
        create: {
          itemId,
          type: ident.type,
          value: ident.value,
          canonicalUri: ident.canonicalUri || null,
        },
        update: {
          value: ident.value,
          canonicalUri: ident.canonicalUri || null,
        },
      }),
    ),
  );
}

export async function syncUpdatedIdentifiers(
  client: { itemIdentifier?: { deleteMany?: (args: unknown) => Promise<unknown>; upsert?: (args: unknown) => Promise<unknown> } },
  itemId: string,
  cleanIds: ReturnType<typeof normalizeItemIdentifiers>,
  existing: ItemDetail | Record<string, unknown>,
): Promise<void> {
  if (!client.itemIdentifier) return;
  const changes = calculateIdentifierChanges(cleanIds, existing);
  await Promise.all(
    changes.map((change) => {
      if (!change.value) {
        return client.itemIdentifier?.deleteMany?.({
          where: { itemId, type: change.type },
        });
      }
      return client.itemIdentifier?.upsert?.({
        where: { itemId_type: { itemId, type: change.type } },
        create: {
          itemId,
          type: change.type,
          value: change.value,
          canonicalUri: change.canonicalUri || null,
        },
        update: {
          value: change.value,
          canonicalUri: change.canonicalUri || null,
        },
      });
    }),
  );
}
