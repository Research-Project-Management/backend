import { resolveProviderFieldWeight } from './source-weights.catalog';
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
  'journalAbbr',
  'publisher',
  'place',
  'volume',
  'issue',
  'pages',
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
  'doi',
  'isbn',
  'issn',
  'pmid',
  'pmcid',
  'arxivId',
  'abstract',
  'abstractNote',
  'url',
  'citationKey',
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
] as const;

export const COUPLED_METADATA_ALIASES: Readonly<
  Record<string, readonly string[]>
> = {
  publicationTitle: ['journal', 'venue'],
  journal: ['publicationTitle', 'venue'],
  abstract: ['abstractNote'],
  abstractNote: ['abstract'],
  publicationDate: ['date'],
  date: ['publicationDate'],
  creators: ['authors'],
  authors: ['creators'],
  arxivId: ['archiveId', 'archiveID'],
  archiveId: ['arxivId', 'archiveID'],
  journalAbbr: ['journalAbbreviation'],
  journalAbbreviation: ['journalAbbr'],
  numPages: ['numberOfPages'],
  numberOfPages: ['numPages'],
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
        if (entry.isUserOverride === true || entry.source === 'UserOverride') {
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
        fieldProv.source === 'manual'
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
    if (this.isFieldLocked(itemOrMeta, fieldKey, aliases)) {
      return false;
    }

    const hasNonEmpty = options.hasNonEmptyExisting ?? true;
    if (!hasNonEmpty) return true;

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
    if (isSystemUpdate) return;

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

    for (const key of TRACKED_MANUAL_LOCK_KEYS) {
      if (dataRecord[key] !== undefined || dataExtra[key] !== undefined) {
        recordManualLock(key);
        for (const coupledAlias of this.getCoupledFieldAliases(key)) {
          recordManualLock(coupledAlias);
        }
      }
    }

    for (const [efKey, efVal] of Object.entries(dataExtra)) {
      if (
        efVal !== undefined &&
        efKey !== 'fieldProvenance' &&
        efKey !== 'lockedFields' &&
        !efKey.startsWith('__')
      ) {
        recordManualLock(efKey);
        for (const coupledAlias of this.getCoupledFieldAliases(efKey)) {
          recordManualLock(coupledAlias);
        }
      }
    }

    if (lockedSet.size > 0) {
      updatedMetadata.fieldProvenance = provenanceMap;
      updatedMetadata.lockedFields = Array.from(lockedSet);
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
    }

    for (const mapped of preview.mappedFields) {
      if (mapped.fromField !== mapped.toField) {
        if (
          provenanceMap[mapped.fromField] !== undefined &&
          provenanceMap[mapped.toField] === undefined
        ) {
          provenanceMap[mapped.toField] = provenanceMap[mapped.fromField];
        }
        if (lockedSet.has(mapped.fromField)) {
          lockedSet.add(mapped.toField);
          lockedSet.delete(mapped.fromField);
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
    const hasExistingProvenanceObj = Boolean(
      currentMeta.fieldProvenance &&
        typeof currentMeta.fieldProvenance === 'object' &&
        !Array.isArray(currentMeta.fieldProvenance),
    );

    const filteredPatch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(sanitizedPatch)) {
      if (k === 'lockedFields' || k === 'fieldProvenance') continue;
      if (this.isFieldLocked(currentMeta, k)) continue;

      const isAiSpecificKey = k.startsWith('ai') || k.startsWith('llm');
      if (!isAiSpecificKey && hasExistingProvenanceObj) {
        const coupled = this.getCoupledFieldAliases(k);
        const existingVal =
          currentMeta[k] !== undefined
            ? currentMeta[k]
            : coupled.map((alias) => currentMeta[alias]).find((val) => val !== undefined);
        const hasNonEmptyExisting = isMeaningfullyNonEmpty(existingVal);
        const hasTrackedProvenance = Boolean(
          provenanceMap[k] || coupled.some((alias) => Boolean(provenanceMap[alias])),
        );
        if (hasNonEmptyExisting && hasTrackedProvenance) {
          const existingAuth = this.getFieldAuthority(currentMeta, k, true);
          if (existingAuth >= 0.7) {
            continue;
          }
        }
      }

      filteredPatch[k] = v;
      if (hasExistingProvenanceObj && !isAiSpecificKey) {
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
      updatedFieldProvenance: hasExistingProvenanceObj
        ? provenanceMap
        : undefined,
    };
  }
}
