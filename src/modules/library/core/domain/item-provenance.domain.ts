import { resolveProviderFieldWeight } from './source-weights.catalog';
import { isPlaceholderItemTitle } from './academic-title.domain';
import { TypeConversionPreview } from '@/modules/library/core/types/bibliographic.types';

export interface FieldProvenanceRecord {
  source?: string;
  sourceProvider?: string;
  confidence?: number;
  verified?: boolean;
  isUserOverride?: boolean;
  isFilenameTitle?: boolean;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface NormalizedProvenanceState {
  lockedSet: Set<string>;
  provenanceMap: Record<string, FieldProvenanceRecord>;
  isFilenameTitle: boolean;
}

export interface ManualLockMutationInput {
  existingMeta: Record<string, unknown>;
  dataRecord: Record<string, unknown>;
  dataExtra?: Record<string, unknown>;
  updatedMetadata: Record<string, unknown>;
}

const TRACKED_MANUAL_LOCK_KEYS = [
  'title',
  'shortTitle',
  'itemType',
  'publicationTitle',
  'journal',
  'venue',
  'journalAbbr',
  'journalAbbreviation',
  'publisher',
  'place',
  'volume',
  'issue',
  'number',
  'pages',
  'numPages',
  'numberOfPages',
  'edition',
  'series',
  'seriesTitle',
  'seriesText',
  'seriesNumber',
  'section',
  'partNumber',
  'partTitle',
  'year',
  'publicationDate',
  'date',
  'accessDate',
  'accessedAt',
  'doi',
  'isbn',
  'issn',
  'pmid',
  'pmcid',
  'arxivId',
  'archiveId',
  'archiveID',
  'abstract',
  'abstractNote',
  'url',
  'citationKey',
  'citeKey',
  'language',
  'rights',
  'license',
  'archive',
  'archiveLocation',
  'libraryCatalog',
  'callNumber',
  'extra',
  'creators',
  'contributors',
  'authors',
  'editors',
  'tags',
  'keywords',
  'labels',
] as const;

export const COUPLED_METADATA_ALIASES: Readonly<
  Record<string, readonly string[]>
> = {
  publicationTitle: ['journal', 'venue'],
  journal: ['publicationTitle', 'venue'],
  venue: ['publicationTitle', 'journal'],
  abstract: ['abstractNote'],
  abstractNote: ['abstract'],
  year: ['date', 'publicationDate'],
  publicationDate: ['date', 'year'],
  date: ['publicationDate', 'year'],
  creators: ['authors', 'contributors'],
  authors: ['creators', 'contributors'],
  contributors: ['creators', 'authors'],
  arxivId: ['archiveId', 'archiveID'],
  archiveId: ['arxivId', 'archiveID'],
  archiveID: ['arxivId', 'archiveId'],
  journalAbbr: ['journalAbbreviation'],
  journalAbbreviation: ['journalAbbr'],
  numPages: ['numberOfPages'],
  numberOfPages: ['numPages'],
  rights: ['license'],
  license: ['rights'],
  citationKey: ['citeKey'],
  citeKey: ['citationKey'],
  accessDate: ['accessedAt'],
  accessedAt: ['accessDate'],
  issue: ['number'],
  number: ['issue'],
  tags: ['keywords', 'labels'],
  keywords: ['tags', 'labels'],
  labels: ['tags', 'keywords'],
};

function asPlainRecord(val: unknown): Record<string, unknown> | null {
  return val && typeof val === 'object' && !Array.isArray(val)
    ? (val as Record<string, unknown>)
    : null;
}

function isMeaningfullyNonEmpty(val: unknown): boolean {
  if (val === undefined || val === null) return false;
  if (typeof val === 'string') return val.trim().length > 0;
  if (Array.isArray(val)) {
    return val.some((entry) => isMeaningfullyNonEmpty(entry));
  }
  if (typeof val === 'object') {
    return Object.values(val as Record<string, unknown>).some((v) =>
      isMeaningfullyNonEmpty(v),
    );
  }
  return true;
}

function extractMetaContainer(itemOrMeta: unknown): Record<string, unknown> {
  const obj = asPlainRecord(itemOrMeta);
  if (!obj) return {};
  const metaObj = asPlainRecord(obj.metadata);
  const extraObj = asPlainRecord(obj.extraFields);
  if (metaObj && extraObj) {
    const mergedLocked = Array.from(
      new Set([
        ...(Array.isArray(obj.lockedFields) ? obj.lockedFields : []),
        ...(Array.isArray(extraObj.lockedFields) ? extraObj.lockedFields : []),
        ...(Array.isArray(metaObj.lockedFields) ? metaObj.lockedFields : []),
      ]),
    );
    const mergedProv = {
      ...(asPlainRecord(obj.fieldProvenance) || {}),
      ...(asPlainRecord(extraObj.fieldProvenance) || {}),
      ...(asPlainRecord(metaObj.fieldProvenance) || {}),
    };
    return {
      ...extraObj,
      ...metaObj,
      ...(mergedLocked.length > 0 ? { lockedFields: mergedLocked } : {}),
      ...(Object.keys(mergedProv).length > 0
        ? { fieldProvenance: mergedProv }
        : {}),
    };
  }
  if (metaObj) {
    if (Array.isArray(obj.lockedFields) && !Array.isArray(metaObj.lockedFields)) {
      return { ...metaObj, lockedFields: obj.lockedFields };
    }
    return metaObj;
  }
  if (extraObj) {
    if (Array.isArray(obj.lockedFields) && !Array.isArray(extraObj.lockedFields)) {
      return { ...extraObj, lockedFields: obj.lockedFields };
    }
    return extraObj;
  }
  return obj;
}

/**
 * ItemProvenancePolicy — Deep Module encapsulating all item field provenance,
 * user-override locks, provider authority calculations, type-conversion lock
 * transfers, duplicate-merge lock promotions, and AI metadata patch filtering.
 */
export class ItemProvenancePolicy {
  /**
   * Returns coupled alias keys for a given metadata field key (e.g. `journal` <-> `publicationTitle`).
   */
  static getCoupledFieldAliases(fieldKey: string): readonly string[] {
    return COUPLED_METADATA_ALIASES[fieldKey] ?? [];
  }
  /**
   * Extracts a normalized, cloned `{ lockedSet, provenanceMap, isFilenameTitle }`
   * from any Item entity, metadata JSON object, or extraFields container.
   */
  static extractProvenanceState(
    itemOrMeta: unknown,
  ): NormalizedProvenanceState {
    const meta = extractMetaContainer(itemOrMeta);
    const lockedSet = new Set<string>(
      Array.isArray(meta.lockedFields)
        ? (meta.lockedFields as unknown[]).filter(
            (k): k is string => typeof k === 'string',
          )
        : [],
    );

    const rawProv =
      meta.fieldProvenance &&
      typeof meta.fieldProvenance === 'object' &&
      !Array.isArray(meta.fieldProvenance)
        ? (meta.fieldProvenance as Record<string, unknown>)
        : {};

    const provenanceMap: Record<string, FieldProvenanceRecord> = {};
    for (const [k, v] of Object.entries(rawProv)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const entry = { ...(v as FieldProvenanceRecord) };
        provenanceMap[k] = entry;
        if (
          entry.isUserOverride === true ||
          entry.source === 'UserOverride' ||
          entry.source === 'manual' ||
          entry.lockedByUser === true ||
          entry.locked === true
        ) {
          lockedSet.add(k);
        }
      }
    }

    const isFilenameTitle = Boolean(
      meta.isFilenameTitle === true ||
        provenanceMap.title?.isFilenameTitle === true,
    );

    return {
      lockedSet,
      provenanceMap,
      isFilenameTitle,
    };
  }

  /**
   * Builds a canonical UserOverride provenance record.
   */
  static createUserOverrideRecord(
    updatedAt: string = new Date().toISOString(),
  ): FieldProvenanceRecord {
    return {
      source: 'UserOverride',
      sourceProvider: 'UserOverride',
      confidence: 1.0,
      verified: true,
      isUserOverride: true,
      updatedAt,
    };
  }

  /**
   * Checks whether a specific field (or any of its canonical aliases) is user-locked.
   */
  static isFieldLocked(
    itemOrMeta: unknown,
    fieldKey: string,
    aliases: string[] = [],
  ): boolean {
    const { lockedSet } = this.extractProvenanceState(itemOrMeta);
    if (lockedSet.has(fieldKey)) return true;
    const allAliases = [...aliases, ...this.getCoupledFieldAliases(fieldKey)];
    return allAliases.some((alias) => lockedSet.has(alias));
  }

  /**
   * Inspects whether a field on a secondary/duplicate item has a user override lock
   * and returns the lock status alongside its provenance entry.
   */
  static inspectFieldUserLock(
    itemOrMeta: unknown,
    fieldKey: string,
  ): { locked: boolean; provenance?: FieldProvenanceRecord } {
    const { lockedSet, provenanceMap } = this.extractProvenanceState(itemOrMeta);
    const coupled = this.getCoupledFieldAliases(fieldKey);
    const locked =
      lockedSet.has(fieldKey) || coupled.some((alias) => lockedSet.has(alias));
    let existingProv = provenanceMap[fieldKey];
    if (!existingProv) {
      for (const alias of coupled) {
        if (provenanceMap[alias]) {
          existingProv = provenanceMap[alias];
          break;
        }
      }
    }
    return {
      locked,
      provenance:
        existingProv ??
        (locked ? this.createUserOverrideRecord() : undefined),
    };
  }

  /**
   * Computes the effective authority weight [0..1] of an existing field on an item.
   */
  static getFieldAuthority(
    itemOrMeta: unknown,
    fieldKey: string,
    hasNonEmptyValue: boolean = true,
    aliases: string[] = [],
  ): number {
    const { lockedSet, provenanceMap, isFilenameTitle } =
      this.extractProvenanceState(itemOrMeta);
    const allAliases = [...aliases, ...this.getCoupledFieldAliases(fieldKey)];
    if (
      lockedSet.has(fieldKey) ||
      allAliases.some((alias) => lockedSet.has(alias))
    ) {
      return 1.0;
    }
    if (!hasNonEmptyValue) return 0;
    if (fieldKey === 'title' && isFilenameTitle) return 0.25;

    let fieldProv = provenanceMap[fieldKey];
    if (!fieldProv) {
      for (const alias of allAliases) {
        if (provenanceMap[alias]) {
          fieldProv = provenanceMap[alias];
          break;
        }
      }
    }
    if (fieldProv) {
      if (
        fieldProv.isUserOverride === true ||
        fieldProv.source === 'UserOverride' ||
        fieldProv.source === 'manual' ||
        fieldProv.lockedByUser === true ||
        fieldProv.locked === true
      ) {
        return 1.0;
      }
      const provider = String(
        fieldProv.sourceProvider || fieldProv.source || 'Unknown',
      );
      const weight = resolveProviderFieldWeight(provider, fieldKey);
      const confidence =
        typeof fieldProv.confidence === 'number' ? fieldProv.confidence : 0.85;
      return weight * confidence;
    }

    const meta = extractMetaContainer(itemOrMeta);
    const itemSource = String(
      meta.engineUsed || meta.sourceProvider || meta.source || 'Unknown',
    );
    return resolveProviderFieldWeight(itemSource, fieldKey) * 0.85;
  }

  /**
   * Determines whether an incoming field update with `incomingAuthority` (or provider)
   * is permitted to overwrite `fieldKey` on `itemOrMeta`.
   */
  static canOverwriteField(
    itemOrMeta: unknown,
    fieldKey: string,
    incomingAuthorityOrProvider: number | string,
    options: {
      hasNonEmptyExisting?: boolean;
      incomingConfidence?: number;
      minAdvantage?: number;
      aliases?: string[];
    } = {},
  ): boolean {
    const aliases = options.aliases ?? [];
    const allAliases = [...aliases, ...this.getCoupledFieldAliases(fieldKey)];
    const meta = extractMetaContainer(itemOrMeta);
    const rawVal =
      meta[fieldKey] !== undefined
        ? meta[fieldKey]
        : (asPlainRecord(itemOrMeta)?.[fieldKey] ??
          allAliases.map((a) => meta[a]).find((v) => v !== undefined));
    const hasNonEmpty =
      options.hasNonEmptyExisting !== undefined
        ? options.hasNonEmptyExisting
        : rawVal !== undefined
          ? isMeaningfullyNonEmpty(rawVal)
          : true;
    if (!hasNonEmpty) return true;

    if (this.isFieldLocked(itemOrMeta, fieldKey, aliases)) {
      return false;
    }

    const existingAuth = this.getFieldAuthority(
      itemOrMeta,
      fieldKey,
      true,
      aliases,
    );
    if (existingAuth >= 1.0) return false;

    const incomingAuth =
      typeof incomingAuthorityOrProvider === 'number'
        ? incomingAuthorityOrProvider
        : resolveProviderFieldWeight(incomingAuthorityOrProvider, fieldKey) *
          (options.incomingConfidence ?? 0.9);

    const minAdvantage = options.minAdvantage ?? 0;
    return incomingAuth >= existingAuth + minAdvantage;
  }

  /**
   * Records manual user-edit locks and coupled field alias locks onto `updatedMetadata`
   * unless the update payload is flagged as an internal system update (`__isSystemUpdate`).
   */
  static applyManualEditLocks(input: ManualLockMutationInput): void {
    const { existingMeta, dataRecord, dataExtra = {}, updatedMetadata } = input;
    const isSystemUpdate = Boolean(
      dataRecord.__isSystemUpdate === true ||
        (typeof dataRecord.__updateSource === 'string' &&
          dataRecord.__updateSource !== 'manual') ||
        dataExtra.__isSystemUpdate === true,
    );
    delete updatedMetadata.__isSystemUpdate;
    delete updatedMetadata.__updateSource;
    if (isSystemUpdate) {
      const explicitMetaPatch = asPlainRecord(dataRecord.metadata);
      if (explicitMetaPatch) {
        if (Array.isArray(explicitMetaPatch.lockedFields)) {
          updatedMetadata.lockedFields = explicitMetaPatch.lockedFields;
          dataRecord.lockedFields = explicitMetaPatch.lockedFields;
          delete dataExtra.lockedFields;
        }
        const explicitProv = asPlainRecord(explicitMetaPatch.fieldProvenance);
        if (explicitProv) {
          updatedMetadata.fieldProvenance = explicitProv;
          dataRecord.fieldProvenance = explicitProv;
          delete dataExtra.fieldProvenance;
        }
      }
      return;
    }

    const { lockedSet, provenanceMap } =
      this.extractProvenanceState(existingMeta);
    const nowIso = new Date().toISOString();

    const recordManualLock = (fieldKey: string) => {
      lockedSet.add(fieldKey);
      provenanceMap[fieldKey] = {
        source: 'UserOverride',
        confidence: 1.0,
        verified: true,
        isUserOverride: true,
        updatedAt: nowIso,
      };
    };

    const unlockFieldAndAliases = (fieldKey: string) => {
      lockedSet.delete(fieldKey);
      delete provenanceMap[fieldKey];
      for (const coupledAlias of this.getCoupledFieldAliases(fieldKey)) {
        lockedSet.delete(coupledAlias);
        delete provenanceMap[coupledAlias];
      }
    };

    const isClearedValue = (val: unknown): boolean => {
      if (val === null) return true;
      if (typeof val === 'string') return val.trim().length === 0;
      if (Array.isArray(val)) return val.length === 0;
      return false;
    };

    const normalizeCompare = (val: unknown): string => {
      if (val === undefined || val === null) return '';
      if (
        typeof val === 'string' ||
        typeof val === 'number' ||
        typeof val === 'boolean'
      ) {
        return String(val).trim();
      }
      if (typeof val === 'object') {
        try {
          return JSON.stringify(val);
        } catch {
          return '';
        }
      }
      return '';
    };

    const isSameReference = existingMeta === updatedMetadata;
    const getExistingFieldValue = (fieldKey: string): unknown => {
      if (isSameReference) return undefined;
      if (existingMeta[fieldKey] !== undefined) return existingMeta[fieldKey];
      for (const alias of this.getCoupledFieldAliases(fieldKey)) {
        if (existingMeta[alias] !== undefined) return existingMeta[alias];
      }
      return undefined;
    };

    const handleCandidateField = (fieldKey: string, rawVal: unknown) => {
      if (rawVal === undefined) return;
      if (isClearedValue(rawVal)) {
        unlockFieldAndAliases(fieldKey);
        return;
      }
      const prevVal = getExistingFieldValue(fieldKey);
      if (
        prevVal !== undefined &&
        normalizeCompare(prevVal) === normalizeCompare(rawVal)
      ) {
        return;
      }
      recordManualLock(fieldKey);
      for (const coupledAlias of this.getCoupledFieldAliases(fieldKey)) {
        recordManualLock(coupledAlias);
      }
    };

    const handledKeys = new Set<string>();
    for (const key of TRACKED_MANUAL_LOCK_KEYS) {
      if (dataRecord[key] !== undefined || dataExtra[key] !== undefined) {
        handledKeys.add(key);
        const rawVal =
          dataRecord[key] !== undefined ? dataRecord[key] : dataExtra[key];
        handleCandidateField(key, rawVal);
      }
    }

    for (const [efKey, efVal] of Object.entries(dataExtra)) {
      if (
        efVal !== undefined &&
        !handledKeys.has(efKey) &&
        efKey !== 'fieldProvenance' &&
        efKey !== 'lockedFields' &&
        efKey !== 'isFilenameTitle' &&
        !efKey.startsWith('__')
      ) {
        handleCandidateField(efKey, efVal);
      }
    }

    if (lockedSet.size > 0) {
      updatedMetadata.fieldProvenance = provenanceMap;
      updatedMetadata.lockedFields = Array.from(lockedSet);
    } else {
      if (Object.keys(provenanceMap).length > 0) {
        updatedMetadata.fieldProvenance = provenanceMap;
      } else {
        delete updatedMetadata.fieldProvenance;
      }
      delete updatedMetadata.lockedFields;
    }
  }

  /**
   * Transfers `fieldProvenance` and `lockedFields` across mapped and dropped fields
   * during an item-type conversion, locking only `itemType` as `UserOverride`.
   */
  static transferConversionProvenance(
    existingItemOrMeta: unknown,
    preview: Pick<TypeConversionPreview, 'droppedFields' | 'mappedFields'>,
  ): {
    fieldProvenance: Record<string, FieldProvenanceRecord>;
    lockedFields: string[];
  } {
    const { lockedSet, provenanceMap } =
      this.extractProvenanceState(existingItemOrMeta);

    for (const dropped of preview.droppedFields) {
      lockedSet.delete(dropped.field);
      delete provenanceMap[dropped.field];
      for (const alias of this.getCoupledFieldAliases(dropped.field)) {
        lockedSet.delete(alias);
        delete provenanceMap[alias];
      }
    }

    for (const mapped of preview.mappedFields) {
      if (mapped.fromField !== mapped.toField) {
        const fromProv =
          provenanceMap[mapped.fromField] ??
          this.getCoupledFieldAliases(mapped.fromField)
            .map((a) => provenanceMap[a])
            .find((p) => p !== undefined);
        if (fromProv !== undefined && provenanceMap[mapped.toField] === undefined) {
          provenanceMap[mapped.toField] = fromProv;
          for (const toAlias of this.getCoupledFieldAliases(mapped.toField)) {
            if (provenanceMap[toAlias] === undefined) {
              provenanceMap[toAlias] = fromProv;
            }
          }
        }
        delete provenanceMap[mapped.fromField];
        const toCoupledSet = new Set(this.getCoupledFieldAliases(mapped.toField));
        for (const fromAlias of this.getCoupledFieldAliases(mapped.fromField)) {
          if (fromAlias !== mapped.toField && !toCoupledSet.has(fromAlias)) {
            delete provenanceMap[fromAlias];
          }
        }
        const wasLocked =
          lockedSet.has(mapped.fromField) ||
          this.getCoupledFieldAliases(mapped.fromField).some((a) => lockedSet.has(a));
        if (wasLocked) {
          lockedSet.add(mapped.toField);
          for (const toAlias of this.getCoupledFieldAliases(mapped.toField)) {
            lockedSet.add(toAlias);
          }
          lockedSet.delete(mapped.fromField);
          for (const fromAlias of this.getCoupledFieldAliases(mapped.fromField)) {
            if (fromAlias !== mapped.toField && !toCoupledSet.has(fromAlias)) {
              lockedSet.delete(fromAlias);
            }
          }
        }
      }
    }

    lockedSet.add('itemType');
    provenanceMap.itemType = this.createUserOverrideRecord();

    return {
      fieldProvenance: provenanceMap,
      lockedFields: Array.from(lockedSet),
    };
  }

  /**
   * Filters an AI metadata patch against existing user locks (including coupled aliases)
   * and authoritative provenance (`authority >= 0.70`), stamping accepted bibliographic
   * fields with `AIMetadata` (`confidence: 0.7`).
   */
  static filterAiMetadataPatch(
    currentMeta: Record<string, unknown>,
    sanitizedPatch: Record<string, unknown>,
  ): {
    filteredPatch: Record<string, unknown>;
    updatedFieldProvenance?: Record<string, FieldProvenanceRecord>;
  } {
    const { provenanceMap } = this.extractProvenanceState(currentMeta);

    const filteredPatch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(sanitizedPatch)) {
      if (k === 'lockedFields' || k === 'fieldProvenance') continue;
      if (!isMeaningfullyNonEmpty(v)) continue;
      if (k === 'title' && isPlaceholderItemTitle(String(v))) continue;
      if (this.isFieldLocked(currentMeta, k)) continue;

      const isAiSpecificKey = k.startsWith('ai') || k.startsWith('llm');
      if (!isAiSpecificKey) {
        const coupled = this.getCoupledFieldAliases(k);
        const existingVal =
          currentMeta[k] !== undefined
            ? currentMeta[k]
            : coupled
                .map((alias) => currentMeta[alias])
                .find((val) => val !== undefined);
        const hasNonEmptyExisting = isMeaningfullyNonEmpty(existingVal);
        if (hasNonEmptyExisting) {
          const existingAuth = this.getFieldAuthority(currentMeta, k, true);
          if (existingAuth >= 0.7) {
            continue;
          }
        }
      }

      filteredPatch[k] = v;
      if (!isAiSpecificKey) {
        provenanceMap[k] = {
          source: 'AIMetadata',
          sourceProvider: 'AIMetadata',
          confidence: 0.7,
          verified: false,
        };
      }
    }

    return {
      filteredPatch,
      updatedFieldProvenance:
        Object.keys(provenanceMap).length > 0 ? provenanceMap : undefined,
    };
  }
}
