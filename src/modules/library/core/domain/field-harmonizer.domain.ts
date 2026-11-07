
import { ALL_CREATOR_ROLES, BASE_FIELD_MAPPINGS, SCHEMA_V42_DATA } from '../types/schema.constants';

const VALID_CREATOR_MAP_CACHE = new Map<string, Map<string, string>>();
let GLOBAL_CREATOR_MAP_CACHE: Map<string, string> | null = null;

const CREATOR_ROLE_SYNONYMS: Readonly<Record<string, string>> = {
  primary_author: 'author',
  primaryauthor: 'author',
  corresponding_author: 'author',
  correspondingauthor: 'author',
  first_author: 'author',
  co_author: 'author',
  coauthor: 'author',
  advisor: 'contributor',
  supervisor: 'contributor',
  thesis_advisor: 'contributor',
};

/**
 * Returns a case-insensitive lookup map (lowercase -> canonical Zotero v42 camelCase)
 * of all 31 global Zotero creator types plus common academic role synonyms.
 */
function getAllCanonicalCreatorMap(): Map<string, string> {
  if (GLOBAL_CREATOR_MAP_CACHE) {
    return GLOBAL_CREATOR_MAP_CACHE;
  }
  const map = new Map<string, string>();
  for (const ct of Object.keys(ALL_CREATOR_ROLES)) {
    map.set(ct.toLowerCase(), ct);
    // Also support snake_case equivalents (e.g. book_author -> bookAuthor)
    const snake = ct.replace(/([A-Z])/g, '_$1').toLowerCase();
    map.set(snake, ct);
  }
  for (const [synonym, target] of Object.entries(CREATOR_ROLE_SYNONYMS)) {
    map.set(synonym.toLowerCase(), target);
  }
  GLOBAL_CREATOR_MAP_CACHE = map;
  return map;
}

/**
 * Returns a case-insensitive lookup map (lowercase -> canonical Zotero v42 camelCase)
 * of valid creator types for a specific Zotero itemType.
 */
export function getValidCreatorMapForType(
  itemType: string,
): Map<string, string> {
  const cached = VALID_CREATOR_MAP_CACHE.get(itemType);
  if (cached) return cached;

  const map = new Map<string, string>();
  const schemaDef = SCHEMA_V42_DATA.itemTypes[itemType];
  if (schemaDef && Array.isArray(schemaDef.creatorTypes)) {
    for (const ct of schemaDef.creatorTypes) {
      map.set(ct.creatorType.toLowerCase(), ct.creatorType);
      const snake = ct.creatorType.replace(/([A-Z])/g, '_$1').toLowerCase();
      map.set(snake, ct.creatorType);
    }
  }
  VALID_CREATOR_MAP_CACHE.set(itemType, map);
  return map;
}

/**
 * Returns the primary creator type for a given Zotero itemType (e.g., 'author' for journalArticle,
 * 'artist' for artwork, 'programmer' for computerProgram, 'inventor' for patent).
 */
export function getPrimaryCreatorRoleForType(itemType?: string): string {
  if (!itemType) return 'author';
  const schemaDef = SCHEMA_V42_DATA.itemTypes[itemType];
  if (schemaDef?.primaryCreatorType) {
    return schemaDef.primaryCreatorType;
  }
  return 'author';
}

/**
 * Resolves any raw creator role string to its canonical Zotero v42 camelCase creatorType.
 *
 * - Preserves valid camelCase roles such as `bookAuthor`, `seriesEditor`, `castMember`, `wordsBy`,
 *   `counsel`, `inventor`, `attorneyAgent`, `recipient`, `podcaster`, `cartographer`, etc.
 * - Normalizes case-insensitive or snake_case inputs (`bookauthor` / `book_author` -> `bookAuthor`).
 * - When `strictForType` is true and `itemType` is provided, falls back to the itemType's
 *   primary creator role (or `'contributor'`) if the role is not valid for that itemType.
 */
export function resolveCanonicalCreatorRole(
  rawRole: string | undefined | null,
  options?: { itemType?: string; strictForType?: boolean },
): string {
  const trimmed = typeof rawRole === 'string' ? rawRole.trim() : '';
  const itemType = options?.itemType;
  const strictForType = options?.strictForType ?? false;

  if (!trimmed) {
    return strictForType ? getPrimaryCreatorRoleForType(itemType) : 'author';
  }

  const lower = trimmed.toLowerCase();

  if (itemType) {
    const validTypeMap = getValidCreatorMapForType(itemType);
    if (validTypeMap.size > 0) {
      const directMatch = validTypeMap.get(lower);
      if (directMatch) return directMatch;

      const synonymTarget = Object.prototype.hasOwnProperty.call(
        CREATOR_ROLE_SYNONYMS,
        lower,
      )
        ? CREATOR_ROLE_SYNONYMS[lower]
        : undefined;
      if (synonymTarget && validTypeMap.has(synonymTarget.toLowerCase())) {
        return validTypeMap.get(synonymTarget.toLowerCase())!;
      }

      if (strictForType) {
        return getPrimaryCreatorRoleForType(itemType);
      }
    }
  }

  const globalMap = getAllCanonicalCreatorMap();
  return globalMap.get(lower) ?? 'author';
}

function isNonEmptyValue(val: unknown): boolean {
  if (val === undefined || val === null) return false;
  if (typeof val === 'string') return val.trim().length > 0;
  return true;
}

function getFirstNonEmpty(
  keys: readonly string[],
  primary: Record<string, unknown>,
  extraSources?: ReadonlyArray<Record<string, unknown> | null | undefined>,
): unknown {
  for (const key of keys) {
    if (isNonEmptyValue(primary[key])) {
      return primary[key];
    }
  }
  if (extraSources) {
    for (const src of extraSources) {
      if (!src || typeof src !== 'object') continue;
      for (const key of keys) {
        if (isNonEmptyValue(src[key])) {
          return src[key];
        }
      }
    }
  }
  return undefined;
}

/**
 * Canonical field mappings from legacy/alias inputs to canonical Zotero/Flux properties.
 */
const CANONICAL_ALIAS_GROUPS: ReadonlyArray<{
  canonical: readonly string[];
  sources: readonly string[];
}> = [
  { canonical: ['doi'], sources: ['doi', 'DOI'] },
  { canonical: ['isbn'], sources: ['isbn', 'ISBN'] },
  { canonical: ['issn'], sources: ['issn', 'ISSN'] },
  { canonical: ['pmid'], sources: ['pmid', 'PMID'] },
  { canonical: ['pmcid'], sources: ['pmcid', 'PMCID'] },
  { canonical: ['arxivId', 'archiveId'], sources: ['arxivId', 'archiveId', 'archiveID'] },
  { canonical: ['journalAbbreviation', 'journalAbbr'], sources: ['journalAbbreviation', 'journalAbbr'] },
  { canonical: ['abstract', 'abstractNote'], sources: ['abstract', 'abstractNote'] },
  { canonical: ['accessDate'], sources: ['accessDate', 'accessedAt'] },
  { canonical: ['citationKey'], sources: ['citationKey', 'citeKey'] },
  { canonical: ['url'], sources: ['url', 'URL'] },
  { canonical: ['rights', 'license'], sources: ['rights', 'license'] },
  { canonical: ['numPages', 'numberOfPages'], sources: ['numPages', 'numberOfPages'] },
  { canonical: ['authority', 'issuingAuthority'], sources: ['authority', 'issuingAuthority'] },
];

/**
 * Resolves all legacy alias inputs into canonical fields in-place on `record`.
 */
export function resolveFieldAliases(
  record: Record<string, unknown>,
  extraSources?: ReadonlyArray<Record<string, unknown> | null | undefined>,
  syncLegacyAliases = false,
): void {
  for (const group of CANONICAL_ALIAS_GROUPS) {
    const val = getFirstNonEmpty(group.sources, record, extraSources);
    if (val !== undefined) {
      const targetKeys = syncLegacyAliases ? group.sources : group.canonical;
      for (const key of targetKeys) {
        if (!isNonEmptyValue(record[key])) {
          if (key === 'accessDate' && val instanceof Date) {
            record[key] = val.toISOString();
          } else if (key === 'accessedAt' && typeof val === 'string') {
            const parsed = new Date(val);
            if (!Number.isNaN(parsed.getTime())) record[key] = parsed;
          } else {
            record[key] = val;
          }
        }
      }
    }
  }
}

const SUPPLEMENTAL_BASE_FIELD_MAPPINGS: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  case: { publicationTitle: 'reporter' },
  statute: { publicationTitle: 'code', volume: 'codeNumber' },
  patent: { place: 'country' },
  conferencePaper: { place: 'eventPlace' },
  presentation: { place: 'eventPlace' },
};

/**
 * Returns the complete base-field-to-type-specific-field mapping for `itemType`,
 * combining Zotero Schema v42 `BASE_FIELD_MAPPINGS` with CSL/Zotero container & place semantics.
 */
export function getEffectiveBaseFieldMap(itemType?: string): Record<string, string> {
  if (!itemType) return {};
  return {
    ...(SUPPLEMENTAL_BASE_FIELD_MAPPINGS[itemType] || {}),
    ...(BASE_FIELD_MAPPINGS[itemType] || {}),
  };
}

/**
 * Returns the reverse mapping (type-specific-field -> base-field) for `itemType`.
 */
export function getEffectiveReverseBaseFieldMap(itemType?: string): Record<string, string> {
  const forward = getEffectiveBaseFieldMap(itemType);
  const reverse: Record<string, string> = {};
  for (const [base, mapped] of Object.entries(forward)) {
    if (mapped) reverse[mapped] = base;
  }
  return reverse;
}

/**
 * Applies Zotero v42 `BASE_FIELD_MAPPINGS` bidirectionally in-place on `record` for the given `itemType`.
 */
export function resolveBidirectionalBaseFields(
  record: Record<string, unknown>,
  itemType?: string,
  extraSources?: ReadonlyArray<Record<string, unknown> | null | undefined>,
  syncLegacyAliases = false,
): void {
  const resolvedType =
    itemType ||
    (typeof record.itemType === 'string' && record.itemType.trim()
      ? record.itemType.trim()
      : typeof record.type === 'string' &&
          record.type.trim() &&
          Boolean(SCHEMA_V42_DATA.itemTypes[record.type.trim()])
        ? record.type.trim()
        : 'journalArticle');

  const pubTitleVal = getFirstNonEmpty(['publicationTitle', 'journal', 'venue'], record, extraSources);
  if (pubTitleVal !== undefined) {
    if (!isNonEmptyValue(record.publicationTitle)) record.publicationTitle = pubTitleVal;
    if (syncLegacyAliases && !isNonEmptyValue(record.journal)) record.journal = pubTitleVal;
  }

  const dateVal = getFirstNonEmpty(['date', 'publicationDate'], record, extraSources);
  if (dateVal !== undefined) {
    if (!isNonEmptyValue(record.date)) record.date = dateVal;
    if (!isNonEmptyValue(record.publicationDate)) record.publicationDate = dateVal;
  }

  const typeMappings = getEffectiveBaseFieldMap(resolvedType);
  for (const [baseField, mappedField] of Object.entries(typeMappings)) {
    if (!mappedField) continue;

    if (baseField === 'type') {
      const rawTypeCandidate =
        typeof record.type === 'string' &&
        record.type.trim() &&
        !SCHEMA_V42_DATA.itemTypes[record.type.trim()]
          ? record.type.trim()
          : undefined;
      const mappedVal =
        getFirstNonEmpty([mappedField, 'genre'], record, extraSources) ?? rawTypeCandidate;
      if (mappedVal !== undefined && !isNonEmptyValue(record[mappedField])) {
        record[mappedField] = mappedVal;
      }
      continue;
    }

    const keysToSearch =
      baseField === 'number' || baseField === 'issue'
        ? [mappedField, 'number', 'issue']
        : baseField === 'date'
          ? [mappedField, 'date', 'publicationDate']
          : baseField === 'publicationTitle'
            ? [mappedField, 'publicationTitle', 'journal', 'venue']
            : baseField === 'place'
              ? [mappedField, 'place', 'eventPlace']
              : [mappedField, baseField];

    const resolvedVal = getFirstNonEmpty(keysToSearch, record, extraSources);
    if (resolvedVal !== undefined) {
      if (!isNonEmptyValue(record[mappedField])) record[mappedField] = resolvedVal;
      if (!isNonEmptyValue(record[baseField])) {
        if (baseField === 'date' && !syncLegacyAliases) {
          if (!isNonEmptyValue(record.publicationDate)) record.publicationDate = resolvedVal;
          if (!isNonEmptyValue(record.date)) record.date = resolvedVal;
        } else {
          record[baseField] = resolvedVal;
        }
      }
      if (baseField === 'number' && !isNonEmptyValue(record.issue)) record.issue = resolvedVal;
      if (baseField === 'issue' && !isNonEmptyValue(record.number)) record.number = resolvedVal;
    }
  }

  if (isNonEmptyValue(record.date) && !isNonEmptyValue(record.publicationDate)) {
    record.publicationDate = record.date;
  }
  if (syncLegacyAliases && isNonEmptyValue(record.publicationTitle) && !isNonEmptyValue(record.journal)) {
    record.journal = record.publicationTitle;
  }
}

export function extractExtraKeyValues(
  extraStr?: string | null,
): Record<string, string> {
  const result: Record<string, string> = {};
  if (!extraStr || typeof extraStr !== 'string') return result;
  for (const match of extraStr.matchAll(
    /\{:\s*([a-zA-Z_][a-zA-Z0-9_.\s-]*?)\s*:\s*([^}]+?)\s*\}/g,
  )) {
    const key = match[1]
      .trim()
      .toLowerCase()
      .replace(/[\s_]+/g, '-');
    result[key] = match[2].trim();
  }
  for (const line of extraStr.split(/\r?\n/)) {
    const m = line.trim().match(/^([a-zA-Z_][a-zA-Z0-9_.\s-]{0,40}):\s*(.+)$/);
    if (m) {
      const key = m[1]
        .trim()
        .toLowerCase()
        .replace(/[\s_]+/g, '-');
      if (!result[key]) {
        result[key] = m[2].trim();
      }
    }
  }
  return result;
}

interface HarmonizeFieldsOptions {
  itemType?: string;
  syncExtraFields?: boolean;
  syncLegacyAliases?: boolean;
  extraSources?: ReadonlyArray<Record<string, unknown> | null | undefined>;
}

/**
 * Pure, idempotent Single-Source-of-Truth harmonizer for Zotero v42 fields and aliases.
 *
 * Guarantees:
 * 1. Idempotency: `harmonizeBibliographicFields(harmonizeBibliographicFields(x))` is deep-equal to `harmonizeBibliographicFields(x)`.
 * 2. Bidirectional `BASE_FIELD_MAPPINGS` across all 37 Zotero item types.
 * 3. Lossless input alias resolution (`DOI` -> `doi`, `ISBN` -> `isbn`, `abstract` <-> `abstractNote`, etc.).
 * 4. Optional synchronization of type-specific mapped fields into `extraFields` when present.
 */
export function harmonizeBibliographicFields<T extends Record<string, unknown>>(
  input: T,
  optionsOrItemType?: HarmonizeFieldsOptions | string,
  maybeOptions?: HarmonizeFieldsOptions,
): T & Record<string, unknown> {
  if (!input || typeof input !== 'object') return input;
  const options: HarmonizeFieldsOptions | undefined =
    typeof optionsOrItemType === 'string'
      ? { ...maybeOptions, itemType: optionsOrItemType }
      : optionsOrItemType;

  const clone: Record<string, unknown> = { ...input };
  const existingExtraFields =
    clone.extraFields &&
    typeof clone.extraFields === 'object' &&
    !Array.isArray(clone.extraFields)
      ? { ...(clone.extraFields as Record<string, unknown>) }
      : undefined;
  if (existingExtraFields) clone.extraFields = existingExtraFields;

  const sources: Array<Record<string, unknown> | null | undefined> = [];
  if (existingExtraFields) sources.push(existingExtraFields);
  if (options?.extraSources) sources.push(...options.extraSources);

  const resolvedItemType =
    options?.itemType ||
    (typeof clone.itemType === 'string' && clone.itemType.trim()
      ? clone.itemType.trim()
      : typeof clone.type === 'string' &&
          clone.type.trim() &&
          Boolean(SCHEMA_V42_DATA.itemTypes[clone.type.trim()])
        ? clone.type.trim()
        : 'journalArticle');

  const syncLegacyAliases = options?.syncLegacyAliases ?? false;

  if (typeof clone.extra === 'string' && clone.extra.trim()) {
    const extraKv = extractExtraKeyValues(clone.extra);
    const kvToCanonical: ReadonlyArray<readonly [readonly string[], string]> = [
      [['doi'], 'doi'],
      [['isbn'], 'isbn'],
      [['issn'], 'issn'],
      [['pmid'], 'pmid'],
      [['pmcid', 'pmc'], 'pmcid'],
      [['arxiv', 'arxivid', 'arxiv-id'], 'arxivId'],
      [['citation-key', 'citationkey', 'citekey'], 'citationKey'],
      [['original-date'], 'originalDate'],
      [['status'], 'status'],
    ];
    for (const [kvKeys, targetField] of kvToCanonical) {
      if (!isNonEmptyValue(clone[targetField])) {
        for (const k of kvKeys) {
          if (extraKv[k]) {
            clone[targetField] = extraKv[k];
            break;
          }
        }
      }
    }
  }

  resolveFieldAliases(clone, sources, syncLegacyAliases);
  resolveBidirectionalBaseFields(clone, resolvedItemType, sources, syncLegacyAliases);
  resolveFieldAliases(clone, sources, syncLegacyAliases);

  if (existingExtraFields && options?.syncExtraFields !== false) {
    const typeMappingsForItem = Object.values(getEffectiveBaseFieldMap(resolvedItemType));
    for (const mappedField of typeMappingsForItem) {
      if (isNonEmptyValue(clone[mappedField]) && !isNonEmptyValue(existingExtraFields[mappedField])) {
        existingExtraFields[mappedField] = clone[mappedField];
      }
    }
  }

  return clone as T & Record<string, unknown>;
}

/**
 * Merges plain-text Zotero `Extra` blocks in priority order, preserving unique `Key: Value`
 * entries and free-form lines without duplicating keys already provided by a higher-trust source.
 */
export function mergeExtraTextWithStatus(
  existingText: string,
  ...incomingVariants: unknown[]
): { merged: string; addedNewLine: boolean } {
  const lines: string[] = [];
  const seenLinesLower = new Set<string>();
  const seenKeysCompact = new Set<string>();
  let addedNewLine = false;

  const ingest = (raw: unknown, isExisting: boolean) => {
    if (typeof raw !== 'string' || !raw.trim()) return;
    for (const rawLine of raw.split(/\r?\n/)) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;
      const lowerLine = trimmed.toLowerCase();
      if (seenLinesLower.has(lowerLine)) continue;

      const kvMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_.\s-]{0,40}):\s*(.+)$/);
      if (kvMatch) {
        const compactKey = kvMatch[1].trim().toLowerCase().replace(/[\s_-]+/g, '');
        if (seenKeysCompact.has(compactKey)) continue;
        seenKeysCompact.add(compactKey);
      }

      seenLinesLower.add(lowerLine);
      lines.push(trimmed);
      if (!isExisting) addedNewLine = true;
    }
  };

  ingest(existingText, true);
  for (const variant of incomingVariants) ingest(variant, false);
  return { merged: lines.join('\n'), addedNewLine };
}

export function mergeExtraTextLines(variants: unknown[]): string {
  const [first, ...rest] = variants;
  return mergeExtraTextWithStatus(
    typeof first === 'string' ? first : '',
    ...(typeof first === 'string' ? rest : variants),
  ).merged;
}

export const harmonizeFields = harmonizeBibliographicFields;

export interface VenueSynchronizationOptions {
  primaryVenue?: string;
  pruneForeignContainerKeys?: boolean;
  syncExtraFields?: boolean;
}

const VENUE_CONTAINER_TYPE_KEYS = [
  'proceedingsTitle',
  'bookTitle',
  'forumTitle',
  'websiteTitle',
  'blogTitle',
  'programTitle',
  'dictionaryTitle',
  'encyclopediaTitle',
  'Series',
] as const;

const pickFirstTrimmedString = (...candidates: unknown[]): string | undefined => {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return undefined;
};

/**
 * Unified Base Field venue synchronization (`publicationTitle` <-> `proceedingsTitle` <-> `bookTitle`
 * <-> `forumTitle` <-> `venue` based on `itemType`).
 */
export function synchronizeVenueBaseFields<T extends Record<string, unknown>>(
  record: T,
  itemType?: string,
  options?: VenueSynchronizationOptions,
): T {
  const target = record as Record<string, unknown>;
  const resolvedType =
    pickFirstTrimmedString(itemType, target.itemType, target.type) || 'journalArticle';
  const typeMap = getEffectiveBaseFieldMap(resolvedType);
  const mappedPublicationTarget = typeMap.publicationTitle || 'publicationTitle';
  const extraObj =
    target.extraFields &&
    typeof target.extraFields === 'object' &&
    !Array.isArray(target.extraFields)
      ? (target.extraFields as Record<string, unknown>)
      : undefined;

  const primaryVenue = pickFirstTrimmedString(
    options?.primaryVenue,
    target[mappedPublicationTarget],
    extraObj?.[mappedPublicationTarget],
    target.publicationTitle,
    target.venue,
    target.proceedingsTitle,
    target.bookTitle,
    target.forumTitle,
    target.websiteTitle,
    target.blogTitle,
    target.journal,
    target.reporter,
    target.code,
    extraObj?.publicationTitle,
    extraObj?.venue,
    extraObj?.proceedingsTitle,
    extraObj?.bookTitle,
    extraObj?.forumTitle,
  );
  if (!primaryVenue) return record;

  target.publicationTitle = primaryVenue;
  target.venue = primaryVenue;
  if (mappedPublicationTarget !== 'publicationTitle') {
    target[mappedPublicationTarget] = primaryVenue;
  }

  if (resolvedType === 'journalArticle' && !pickFirstTrimmedString(target.journal)) {
    target.journal = primaryVenue;
  } else if (resolvedType === 'preprint' && !pickFirstTrimmedString(target.repository)) {
    target.repository = primaryVenue;
  }

  if (options?.pruneForeignContainerKeys) {
    for (const containerKey of VENUE_CONTAINER_TYPE_KEYS) {
      if (containerKey !== mappedPublicationTarget) {
        delete target[containerKey];
        if (extraObj && options?.syncExtraFields !== false) {
          delete extraObj[containerKey];
        }
      }
    }
  }

  if (extraObj && options?.syncExtraFields !== false) {
    extraObj.publicationTitle = primaryVenue;
    extraObj.venue = primaryVenue;
    if (mappedPublicationTarget !== 'publicationTitle') {
      extraObj[mappedPublicationTarget] = primaryVenue;
    }
  }

  return record;
}

export interface BibliographicMutationPayloadResult {
  harmonized: Record<string, unknown>;
  resolvedType: string;
  resolvedTitle: string | undefined;
  primaryVenue: string | undefined;
  mappedPublicationField: string;
  publicationDateStr: string | undefined;
  resolvedYear: number | undefined;
}

/**
 * Normalizes and harmonizes a bibliographic record or mutation command into canonical
 * base fields, resolved title fallback, venue container synchronization, and publication year/date.
 */
export function buildBibliographicMutationPayload(
  input: Record<string, unknown>,
  options?: {
    itemType?: string;
    extraSources?: Array<Record<string, unknown> | null | undefined>;
    pruneForeignContainerKeys?: boolean;
  },
): BibliographicMutationPayloadResult {
  const resolvedType =
    pickFirstTrimmedString(options?.itemType, input.itemType, input.type) || 'journalArticle';
  const harmonized = harmonizeBibliographicFields({ ...input }, {
    itemType: resolvedType,
    extraSources: options?.extraSources,
    syncLegacyAliases: true,
    syncExtraFields: true,
  });

  synchronizeVenueBaseFields(harmonized, resolvedType, {
    pruneForeignContainerKeys: options?.pruneForeignContainerKeys,
    syncExtraFields: true,
  });

  const typeMap = getEffectiveBaseFieldMap(resolvedType);
  const mappedPublicationField = typeMap.publicationTitle || 'publicationTitle';
  const resolvedTitle = pickFirstTrimmedString(
    harmonized.title,
    harmonized.caseName,
    harmonized.nameOfAct,
    harmonized.subject,
  );
  if (resolvedTitle && !pickFirstTrimmedString(harmonized.title)) {
    harmonized.title = resolvedTitle;
  }

  const primaryVenue = pickFirstTrimmedString(
    harmonized[mappedPublicationField],
    harmonized.publicationTitle,
    harmonized.venue,
    harmonized.proceedingsTitle,
    harmonized.bookTitle,
    harmonized.forumTitle,
    harmonized.journal,
  );
  const publicationDateStr = pickFirstTrimmedString(
    harmonized.publicationDate,
    harmonized.date,
    harmonized.dateDecided,
    harmonized.dateEnacted,
    harmonized.issueDate,
    harmonized.filingDate,
  );

  let resolvedYear: number | undefined =
    typeof harmonized.year === 'number' && Number.isFinite(harmonized.year)
      ? harmonized.year
      : undefined;
  if (resolvedYear === undefined && publicationDateStr) {
    const yearMatch = publicationDateStr.match(/\b(1[0-9]{3}|20[0-9]{2})\b/);
    if (yearMatch) {
      const parsed = parseInt(yearMatch[1], 10);
      if (parsed >= 1000 && parsed <= 2100) resolvedYear = parsed;
    }
  }

  return {
    harmonized,
    resolvedType,
    resolvedTitle,
    primaryVenue,
    mappedPublicationField,
    publicationDateStr,
    resolvedYear,
  };
}

