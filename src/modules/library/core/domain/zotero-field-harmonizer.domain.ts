import { CANONICAL_BIBLIOGRAPHIC_COLUMN_AND_ALIAS_KEYS } from '../types/bibliographic.types';
import {
  ALL_CREATOR_ROLES,
  BASE_FIELD_MAPPINGS,
  FIELD_ALIASES,
  SCHEMA_V42_DATA,
} from '../types/schema.constants';

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
export function getAllCanonicalCreatorMap(): Map<string, string> {
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
  {
    canonical: ['arxivId', 'archiveId'],
    sources: ['arxivId', 'archiveId', 'archiveID'],
  },
  {
    canonical: ['journalAbbreviation', 'journalAbbr'],
    sources: ['journalAbbreviation', 'journalAbbr'],
  },
  {
    canonical: ['abstract', 'abstractNote'],
    sources: ['abstract', 'abstractNote'],
  },
  { canonical: ['accessDate'], sources: ['accessDate', 'accessedAt'] },
  { canonical: ['citationKey'], sources: ['citationKey', 'citeKey'] },
  { canonical: ['url'], sources: ['url', 'URL'] },
  { canonical: ['rights', 'license'], sources: ['rights', 'license'] },
  {
    canonical: ['numPages', 'numberOfPages'],
    sources: ['numPages', 'numberOfPages'],
  },
  {
    canonical: ['authority', 'issuingAuthority'],
    sources: ['authority', 'issuingAuthority'],
  },
];

/**
 * Resolves all legacy alias inputs into canonical fields in-place on `record`.
 * Does not overwrite existing non-empty values on `record` and does not write duplicate legacy alias keys unless `syncLegacyAliases` is true.
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
            if (!Number.isNaN(parsed.getTime())) {
              record[key] = parsed;
            }
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
  case: {
    publicationTitle: 'reporter',
  },
  statute: {
    publicationTitle: 'code',
    volume: 'codeNumber',
  },
  patent: {
    place: 'country',
  },
  conferencePaper: {
    place: 'eventPlace',
  },
  presentation: {
    place: 'eventPlace',
  },
};

/**
 * Returns the complete base-field-to-type-specific-field mapping for `itemType`,
 * combining Zotero Schema v42 `BASE_FIELD_MAPPINGS` with CSL/Zotero container & place semantics.
 */
export function getEffectiveBaseFieldMap(
  itemType?: string,
): Record<string, string> {
  if (!itemType) return {};
  const schemaMap = BASE_FIELD_MAPPINGS[itemType] || {};
  const supplemental = SUPPLEMENTAL_BASE_FIELD_MAPPINGS[itemType] || {};
  return {
    ...supplemental,
    ...schemaMap,
  };
}

/**
 * Returns the reverse mapping (type-specific-field -> base-field) for `itemType`.
 */
export function getEffectiveReverseBaseFieldMap(
  itemType?: string,
): Record<string, string> {
  const forward = getEffectiveBaseFieldMap(itemType);
  const reverse: Record<string, string> = {};
  for (const [base, mapped] of Object.entries(forward)) {
    if (mapped) {
      reverse[mapped] = base;
    }
  }
  return reverse;
}

/**
 * Applies Zotero v42 `BASE_FIELD_MAPPINGS` bidirectionally in-place on `record` for the given `itemType`.
 *
 * Note: `BASE_FIELD_MAPPINGS` is indexed by `itemType` -> `Record<baseField, mappedField>`.
 * Examples:
 * - `case`: `title` <-> `caseName`, `publicationTitle` <-> `reporter`, `volume` <-> `reporterVolume`, `pages` <-> `firstPage`, `date` <-> `dateDecided`, `authority` <-> `court`, `number` <-> `docketNumber`
 * - `statute`: `title` <-> `nameOfAct`, `publicationTitle` <-> `code`, `volume` <-> `codeNumber`, `number` <-> `publicLawNumber`, `date` <-> `dateEnacted`
 * - `patent`: `number` <-> `patentNumber`, `date` <-> `issueDate`, `place` <-> `country`, `authority` <-> `issuingAuthority`
 * - `thesis`: `publisher` <-> `university`, `type` <-> `thesisType`
 * - `report`: `publisher` <-> `institution`, `number` <-> `reportNumber`, `type` <-> `reportType`
 * - `conferencePaper`: `publicationTitle` <-> `proceedingsTitle`, `place` <-> `eventPlace`
 * - `bookSection`: `publicationTitle` <-> `bookTitle`
 * - `webpage`: `publicationTitle` <-> `websiteTitle`, `type` <-> `websiteType`
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

  // Resolve legacy journal/venue -> publicationTitle and date <-> publicationDate on input
  const pubTitleVal = getFirstNonEmpty(
    ['publicationTitle', 'journal', 'venue'],
    record,
    extraSources,
  );
  if (pubTitleVal !== undefined) {
    if (!isNonEmptyValue(record.publicationTitle)) {
      record.publicationTitle = pubTitleVal;
    }
    if (syncLegacyAliases && !isNonEmptyValue(record.journal)) {
      record.journal = pubTitleVal;
    }
  }

  const dateVal = getFirstNonEmpty(
    ['date', 'publicationDate'],
    record,
    extraSources,
  );
  if (dateVal !== undefined) {
    if (!isNonEmptyValue(record.date)) {
      record.date = dateVal;
    }
    if (!isNonEmptyValue(record.publicationDate)) {
      record.publicationDate = dateVal;
    }
  }

  const typeMappings = getEffectiveBaseFieldMap(resolvedType);
  for (const [baseField, mappedField] of Object.entries(typeMappings)) {
    if (!mappedField) continue;

    // Never overwrite itemType (`type`) with genre/subtype when `baseField === 'type'`
    // unless we are reading from `mappedField` (`thesisType`, `reportType`, `websiteType`, etc.)
    if (baseField === 'type') {
      const rawTypeCandidate =
        typeof record.type === 'string' &&
        record.type.trim() &&
        !SCHEMA_V42_DATA.itemTypes[record.type.trim()]
          ? record.type.trim()
          : undefined;
      const mappedVal =
        getFirstNonEmpty([mappedField, 'genre'], record, extraSources) ??
        rawTypeCandidate;
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
      if (!isNonEmptyValue(record[mappedField])) {
        record[mappedField] = resolvedVal;
      }
      if (!isNonEmptyValue(record[baseField])) {
        if (baseField === 'date' && !syncLegacyAliases) {
          if (!isNonEmptyValue(record.publicationDate)) {
            record.publicationDate = resolvedVal;
          }
          if (!isNonEmptyValue(record.date)) {
            record.date = resolvedVal;
          }
        } else {
          record[baseField] = resolvedVal;
        }
      }
      // In Flux DB schema, `issue` column stores `number`/`issue` base semantics
      if (baseField === 'number' && !isNonEmptyValue(record.issue)) {
        record.issue = resolvedVal;
      }
      if (baseField === 'issue' && !isNonEmptyValue(record.number)) {
        record.number = resolvedVal;
      }
    }
  }

  if (
    isNonEmptyValue(record.date) &&
    !isNonEmptyValue(record.publicationDate)
  ) {
    record.publicationDate = record.date;
  }

  if (syncLegacyAliases) {
    if (
      isNonEmptyValue(record.publicationTitle) &&
      !isNonEmptyValue(record.journal)
    ) {
      record.journal = record.publicationTitle;
    }
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

export interface HarmonizeZoteroFieldsOptions {
  itemType?: string;
  syncExtraFields?: boolean;
  syncLegacyAliases?: boolean;
  extraSources?: ReadonlyArray<Record<string, unknown> | null | undefined>;
}

/**
 * Pure, idempotent Single-Source-of-Truth harmonizer for Zotero v42 fields and aliases.
 *
 * Guarantees:
 * 1. Idempotency: `harmonizeZoteroFields(harmonizeZoteroFields(x))` is deep-equal to `harmonizeZoteroFields(x)`.
 * 2. Bidirectional `BASE_FIELD_MAPPINGS` across all 37 Zotero item types.
 * 3. Lossless input alias resolution (`DOI` -> `doi`, `ISBN` -> `isbn`, `abstract` <-> `abstractNote`, etc.).
 * 4. Optional synchronization of type-specific mapped fields into `extraFields` when present.
 */
export function harmonizeZoteroFields<T extends Record<string, unknown>>(
  input: T,
  options?: HarmonizeZoteroFieldsOptions,
): T {
  if (!input || typeof input !== 'object') return input;

  const clone: Record<string, unknown> = { ...input };
  const existingExtraFields =
    clone.extraFields &&
    typeof clone.extraFields === 'object' &&
    !Array.isArray(clone.extraFields)
      ? { ...(clone.extraFields as Record<string, unknown>) }
      : undefined;

  if (existingExtraFields) {
    clone.extraFields = existingExtraFields;
  }

  const sources: Array<Record<string, unknown> | null | undefined> = [];
  if (existingExtraFields) {
    sources.push(existingExtraFields);
  }
  if (options?.extraSources) {
    sources.push(...options.extraSources);
  }

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

  // 0. Extract CSL braced & line-based identifiers/metadata from `extra` if present
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

  // 1. Synchronize aliases across top-level and extraSources
  resolveFieldAliases(clone, sources, syncLegacyAliases);

  // 2. Synchronize bidirectional BASE_FIELD_MAPPINGS for resolvedItemType
  resolveBidirectionalBaseFields(
    clone,
    resolvedItemType,
    sources,
    syncLegacyAliases,
  );

  // 3. Re-run alias resolution in case base field mapping populated a field with an alias
  resolveFieldAliases(clone, sources, syncLegacyAliases);

  // 4. Mirror type-specific mapped fields into extraFields if extraFields exists and syncExtraFields !== false
  if (existingExtraFields && options?.syncExtraFields !== false) {
    const typeMappingsForItem = Object.values(
      getEffectiveBaseFieldMap(resolvedItemType),
    );
    for (const mappedField of typeMappingsForItem) {
      if (
        isNonEmptyValue(clone[mappedField]) &&
        !isNonEmptyValue(existingExtraFields[mappedField])
      ) {
        existingExtraFields[mappedField] = clone[mappedField];
      }
    }
  }

  return clone as T;
}

/**
 * Comprehensive, schema-derived set of all metadata field keys that can participate
 * in multi-source metadata reconciliation (`ReconciliationService`).
 * Derived dynamically from `SCHEMA_V42_DATA.distinctFieldKeys`, `ITEM_COLUMN_METADATA_FIELDS`,
 * and `FIELD_ALIASES` so no Zotero v42 field is ever dropped.
 */
export const ALL_RECONCILABLE_METADATA_FIELDS: ReadonlyArray<string> = (() => {
  const excludedTopLevel = new Set([
    'title',
    'creators',
    'authors',
    'editors',
    'contributors',
    'itemType',
    'type',
    'extra',
    'extraFields',
    'metadata',
    'attachments',
    'notes',
    'notesList',
    'collections',
    'collectionIds',
    'collectionId',
  ]);
  const fieldSet = new Set<string>([
    'abstract',
    'abstractNote',
    'publicationDate',
    'date',
    'year',
    'publicationTitle',
    'journal',
    'venue',
    'publisher',
    'volume',
    'issue',
    'number',
    'pages',
    'doi',
    'DOI',
    'isbn',
    'ISBN',
    'issn',
    'ISSN',
    'pmid',
    'PMID',
    'pmcid',
    'PMCID',
    'arxivId',
    'archiveId',
    'archiveID',
    'url',
    'URL',
    'openAccessPdfUrl',
    'language',
    'rights',
    'license',
    'tags',
    'citationCount',
    'referenceCount',
  ]);

  for (const key of CANONICAL_BIBLIOGRAPHIC_COLUMN_AND_ALIAS_KEYS) {
    if (!excludedTopLevel.has(key)) {
      fieldSet.add(key);
    }
  }
  for (const key of SCHEMA_V42_DATA.distinctFieldKeys) {
    if (!excludedTopLevel.has(key)) {
      fieldSet.add(key);
    }
  }
  for (const [alias, target] of Object.entries(FIELD_ALIASES)) {
    if (!excludedTopLevel.has(alias)) fieldSet.add(alias);
    if (!excludedTopLevel.has(target)) fieldSet.add(target);
  }
  return Array.from(fieldSet);
})();

/**
 * Merges plain-text Zotero `Extra` blocks in priority order, preserving unique `Key: Value`
 * entries and free-form lines without duplicating keys already provided by a higher-trust source.
 */
export function mergeZoteroExtraTextWithStatus(
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

      const kvMatch = trimmed.match(
        /^([a-zA-Z_][a-zA-Z0-9_.\s-]{0,40}):\s*(.+)$/,
      );
      if (kvMatch) {
        const compactKey = kvMatch[1]
          .trim()
          .toLowerCase()
          .replace(/[\s_-]+/g, '');
        if (seenKeysCompact.has(compactKey)) continue;
        seenKeysCompact.add(compactKey);
      }

      seenLinesLower.add(lowerLine);
      lines.push(trimmed);
      if (!isExisting) addedNewLine = true;
    }
  };

  ingest(existingText, true);
  for (const variant of incomingVariants) {
    ingest(variant, false);
  }

  return { merged: lines.join('\n'), addedNewLine };
}

export function mergeZoteroExtraTextLines(variants: unknown[]): string {
  const [first, ...rest] = variants;
  return mergeZoteroExtraTextWithStatus(
    typeof first === 'string' ? first : '',
    ...(typeof first === 'string' ? rest : variants),
  ).merged;
}
