import { ItemMetadata, Provenance, MetadataCandidate, FieldEvidence } from '@/modules/library/ingestion/types/metadata.types';
import { normalizeDoi, normalizeArxivId, normalizePmid, normalizePmcid, normalizeIsbn, normalizeIssn, normalizeTags, ItemProvenancePolicy } from '@/modules/library/core';
import { randomUUID } from 'crypto';
import { ParsedBibtexEntry } from '@/modules/library/ingestion/parsers/bibtex.parser';
import { NormalizationPolicy } from '@/modules/library/ingestion/policies/normalization.policy';

export function validateMetadata(metadata: unknown): ItemMetadata | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null;
  }

  const raw = metadata as ItemMetadata;
  const title = raw.title?.trim();
  if (
    !title ||
    /^untitled(\s+paper|\s+document|\s+record|\s+arxiv\s+paper)?$/i.test(title)
  ) {
    return null;
  }

  const normalized: ItemMetadata = {
    ...raw,
    title,
    authors: Array.isArray(raw.authors)
      ? raw.authors
          .map((author: unknown) =>
            typeof author === 'string' ? author.trim() : '',
          )
          .filter(Boolean)
      : undefined,
    year: typeof raw.year === 'string' ? parseInt(raw.year, 10) : raw.year,
    doi: normalizeDoi(raw.doi),
    arxivId: normalizeArxivId(raw.arxivId),
    pmid: normalizePmid(raw.pmid),
    pmcid: normalizePmcid(raw.pmcid),
    isbn: normalizeIsbn(raw.isbn),
    issn: normalizeIssn(raw.issn),
    tags: normalizeTags(raw.tags ?? raw.keywords),
    keywords: normalizeTags(raw.keywords),
  };

  if (raw.provenance && typeof raw.provenance === 'object') {
    const p = raw.provenance as Partial<Provenance>;
    normalized.provenance = {
      ...p,
      resolvedAt: p.resolvedAt ?? new Date().toISOString(),
      confidenceScore: p.confidenceScore ?? 1,
      isOpenAccess: p.isOpenAccess ?? false,
    };
  }

  return normalized;
}

export const QUALITY_RULE_BIT = {
  title: 1 << 0,
  authors: 1 << 1,
  year: 1 << 2,
  identifier: 1 << 3,
  doi: 1 << 4,
  context: 1 << 5,
  abstract: 1 << 6,
} as const;

export interface IBibliographicQualityRule {
  readonly id: keyof typeof QUALITY_RULE_BIT;
  readonly bit: number;
  readonly fieldKey?: string;
  readonly issueCode?: string;
  readonly weight: number;
  isSatisfied(item: Record<string, unknown>): boolean;
}

export const BIBLIOGRAPHIC_QUALITY_RULES: readonly IBibliographicQualityRule[] =
  [
    {
      id: 'title',
      bit: QUALITY_RULE_BIT.title,
      fieldKey: 'title',
      issueCode: 'missing_title',
      weight: 25,
      isSatisfied(item: Record<string, unknown>): boolean {
        return typeof item.title === 'string' && item.title.trim().length > 3;
      },
    },
    {
      id: 'authors',
      bit: QUALITY_RULE_BIT.authors,
      fieldKey: 'authors',
      issueCode: 'missing_authors',
      weight: 25,
      isSatisfied(item: Record<string, unknown>): boolean {
        return Boolean(
          (Array.isArray(item.creators) && item.creators.length > 0) ||
          (Array.isArray(item.authors) && item.authors.length > 0) ||
          (Array.isArray(item.contributors) && item.contributors.length > 0),
        );
      },
    },
    {
      id: 'year',
      bit: QUALITY_RULE_BIT.year,
      fieldKey: 'year',
      issueCode: 'missing_year',
      weight: 15,
      isSatisfied(item: Record<string, unknown>): boolean {
        if (typeof item.year === 'number') {
          return item.year > 1900;
        }
        if (typeof item.year === 'string' && item.year.trim().length > 0) {
          const parsed = parseInt(item.year.trim(), 10);
          return !Number.isNaN(parsed) && parsed > 1900;
        }
        return Boolean(item.publicationDate || item.date);
      },
    },
    {
      id: 'identifier',
      bit: QUALITY_RULE_BIT.identifier,
      fieldKey: 'identifier',
      weight: 15,
      isSatisfied(item: Record<string, unknown>): boolean {
        return Boolean(
          item.doi ||
          item.isbn ||
          item.issn ||
          item.arxivId ||
          item.pmid ||
          item.pmcid ||
          item.url,
        );
      },
    },
    {
      id: 'doi',
      bit: QUALITY_RULE_BIT.doi,
      issueCode: 'missing_doi',
      weight: 0,
      isSatisfied(item: Record<string, unknown>): boolean {
        return Boolean(item.doi && String(item.doi).trim().length > 0);
      },
    },
    {
      id: 'context',
      bit: QUALITY_RULE_BIT.context,
      weight: 10,
      isSatisfied(item: Record<string, unknown>): boolean {
        return Boolean(
          item.publicationTitle ||
          item.journal ||
          item.publisher ||
          item.bookTitle ||
          item.proceedingsTitle ||
          item.conferenceName,
        );
      },
    },
    {
      id: 'abstract',
      bit: QUALITY_RULE_BIT.abstract,
      fieldKey: 'abstract',
      issueCode: 'missing_abstract',
      weight: 10,
      isSatisfied(item: Record<string, unknown>): boolean {
        return Boolean(item.abstract || item.abstractNote);
      },
    },
  ];

export interface MetadataQualityEvaluation {
  score: number; // 0 - 100
  level: 'complete' | 'adequate' | 'minimal';
  missingKeyFields: string[];
  issues: string[];
  presentFieldsCount: number;
  satisfiedMask: number;
  missingIssueMask: number;
  hasTitle: boolean;
  hasAuthors: boolean;
  hasYear: boolean;
  hasIdentifier: boolean;
  hasDoi: boolean;
  hasContext: boolean;
  hasAbstract: boolean;
}

/**
 * Canonical completeness/quality scoring helper shared across QualityService and IngestionVerifierService.
 */
export function calculateMetadataQualityScore(
  item: Record<string, unknown>,
  options?: { typeSpecificKeys?: string[] },
): MetadataQualityEvaluation {
  const missingKeyFields: string[] = [];
  const issues: string[] = [];
  let presentCount = 0;
  let totalScore = 0;
  let satisfiedMask = 0;
  let missingIssueMask = 0;

  for (const rule of BIBLIOGRAPHIC_QUALITY_RULES) {
    if (rule.isSatisfied(item)) {
      satisfiedMask |= rule.bit;
      if (rule.weight > 0) {
        const effectiveWeight =
          rule.id === 'abstract' && options?.typeSpecificKeys?.length
            ? 5
            : rule.weight;
        totalScore += effectiveWeight;
        presentCount++;
      }
    } else {
      if (rule.fieldKey) {
        missingKeyFields.push(rule.fieldKey);
      }
      if (rule.issueCode) {
        issues.push(rule.issueCode);
        missingIssueMask |= rule.bit;
      }
    }
  }

  // Optional type-specific fields (5 pts)
  if (options?.typeSpecificKeys && options.typeSpecificKeys.length > 0) {
    let extraFields: Record<string, unknown> = {};
    if (item.extraFields && typeof item.extraFields === 'object') {
      extraFields = item.extraFields as Record<string, unknown>;
    } else if (
      typeof item.extra === 'string' &&
      item.extra.trim().startsWith('{')
    ) {
      try {
        extraFields = JSON.parse(item.extra) as Record<string, unknown>;
      } catch {
        // ignore
      }
    }

    const hasTypeSpecific = options.typeSpecificKeys.some(
      (k: string) => Boolean(item[k]) || Boolean(extraFields[k]),
    );
    if (hasTypeSpecific) {
      totalScore += 5;
      presentCount++;
    }
  }

  const score = Math.min(100, Math.max(0, totalScore));
  let level: 'complete' | 'adequate' | 'minimal' = 'minimal';
  if (score >= 80) level = 'complete';
  else if (score >= 50) level = 'adequate';

  return {
    score,
    level,
    missingKeyFields,
    issues,
    presentFieldsCount: presentCount,
    satisfiedMask,
    missingIssueMask,
    hasTitle: (satisfiedMask & QUALITY_RULE_BIT.title) !== 0,
    hasAuthors: (satisfiedMask & QUALITY_RULE_BIT.authors) !== 0,
    hasYear: (satisfiedMask & QUALITY_RULE_BIT.year) !== 0,
    hasIdentifier: (satisfiedMask & QUALITY_RULE_BIT.identifier) !== 0,
    hasDoi: (satisfiedMask & QUALITY_RULE_BIT.doi) !== 0,
    hasContext: (satisfiedMask & QUALITY_RULE_BIT.context) !== 0,
    hasAbstract: (satisfiedMask & QUALITY_RULE_BIT.abstract) !== 0,
  };
}

export function diagnoseBibliographicQualityIssues(
  item: Record<string, unknown>,
  existingEvaluation?: MetadataQualityEvaluation,
): {
  evaluation: MetadataQualityEvaluation;
  issues: string[];
  isHealthy: boolean;
} {
  const evaluation = existingEvaluation ?? calculateMetadataQualityScore(item);
  return {
    evaluation,
    issues: evaluation.issues,
    isHealthy: evaluation.issues.length === 0,
  };
}

export function buildEvidenceFields(
  rawMetadata: Record<string, unknown>,
  normalizedMetadata: Record<string, unknown>,
  sourceName: string,
  defaultConfidence = 0.95,
): Record<string, FieldEvidence> {
  const fields: Record<string, FieldEvidence> = {};
  for (const fieldName of Object.keys(normalizedMetadata)) {
    if (
      normalizedMetadata[fieldName] !== undefined &&
      normalizedMetadata[fieldName] !== null
    ) {
      fields[fieldName] = {
        path: fieldName,
        value:
          rawMetadata[fieldName] !== undefined
            ? rawMetadata[fieldName]
            : normalizedMetadata[fieldName],
        normalizedValue: normalizedMetadata[fieldName],
        confidence: defaultConfidence,
        sourceProvider: sourceName,
        retrievedAt: new Date().toISOString(),
      };
    }
  }
  return fields;
}

export function createCandidate(params: {
  sourceKind: MetadataCandidate['sourceKind'];
  sourceName: string;
  sourceRecordId?: string;
  rawMetadata: Record<string, unknown>;
  normalizedMetadata?: Record<string, unknown>;
  confidenceScore: number;
  fieldOverrides?: Record<string, FieldEvidence>;
  normalizer: NormalizationPolicy;
}): MetadataCandidate {
  const normalized =
    params.normalizedMetadata ??
    params.normalizer.normalize(params.rawMetadata);

  return {
    candidateId: randomUUID(),
    sourceKind: params.sourceKind,
    sourceName: params.sourceName,
    sourceRecordId: params.sourceRecordId,
    retrievedAt: new Date().toISOString(),
    schemaVersion: '1.0.0',
    fields: {
      ...buildEvidenceFields(
        params.rawMetadata,
        normalized,
        params.sourceName,
        params.confidenceScore,
      ),
      ...(params.fieldOverrides || {}),
    },
    normalizedMetadata: normalized,
    confidenceScore: params.confidenceScore,
  };
}

/**
 * Applies explicit user overrides onto an identified MetadataCandidate so that both
 * `normalizedMetadata` AND `fields` (`FieldEvidence`) carry `UserOverride` provenance
 * (`confidence: 1.0`, `isUserOverride: true`) and survive downstream reconciliation.
 */
export function applyUserOverridesToCandidate(
  candidate: MetadataCandidate,
  overrides: Record<string, unknown> | undefined,
  normalizer: NormalizationPolicy,
): MetadataCandidate {
  if (!overrides || Object.keys(overrides).length === 0) {
    return candidate;
  }

  // Clear coupled aliases from base candidate metadata before merging overrides so stale candidate
  // alias values (e.g. `journal` when user overrode `publicationTitle`) cannot survive normalization.
  const baseMetaClean: Record<string, unknown> = {
    ...(candidate.normalizedMetadata || {}),
  };
  const explicitOverrideKeys = new Set<string>();
  const coupledOverrideKeys = new Set<string>();

  for (const [key, rawVal] of Object.entries(overrides)) {
    if (rawVal === undefined || rawVal === null) continue;
    explicitOverrideKeys.add(key);
    for (const alias of ItemProvenancePolicy.getCoupledFieldAliases(key)) {
      if (!(alias in overrides)) {
        delete baseMetaClean[alias];
      }
      coupledOverrideKeys.add(alias);
    }
  }

  const mergedNormalized = normalizer.normalize({
    ...baseMetaClean,
    ...overrides,
  });
  const nowIso = new Date().toISOString();
  const updatedFields: Record<string, FieldEvidence> = {
    ...(candidate.fields || {}),
  };

  for (const key of explicitOverrideKeys) {
    const rawVal = overrides[key];
    const normVal =
      (mergedNormalized as Record<string, unknown>)[key] ?? rawVal;
    updatedFields[key] = {
      path: key,
      value: rawVal,
      normalizedValue: normVal,
      confidence: 1.0,
      sourceProvider: 'UserOverride',
      retrievedAt: nowIso,
      isUserOverride: true,
    };
  }

  for (const aliasKey of coupledOverrideKeys) {
    if (explicitOverrideKeys.has(aliasKey)) continue;
    const aliasVal = (mergedNormalized as Record<string, unknown>)[aliasKey];
    if (aliasVal === undefined || aliasVal === null) continue;
    updatedFields[aliasKey] = {
      path: aliasKey,
      value: aliasVal,
      normalizedValue: aliasVal,
      confidence: 1.0,
      sourceProvider: 'UserOverride',
      retrievedAt: nowIso,
      isUserOverride: true,
    };
  }

  return {
    ...candidate,
    fields: updatedFields,
    normalizedMetadata: mergedNormalized,
  };
}

export function mapBibtexToRawRecord(
  item: ParsedBibtexEntry | Record<string, unknown>,
): Record<string, unknown> {
  const extraFields: Record<string, unknown> = {
    ...(typeof item.extraFields === 'object' && item.extraFields !== null
      ? (item.extraFields as Record<string, unknown>)
      : {}),
    ...(item.university ? { university: item.university } : {}),
    ...(item.institution ? { institution: item.institution } : {}),
    ...(item.thesisType ? { thesisType: item.thesisType } : {}),
    ...(item.reportNumber ? { reportNumber: item.reportNumber } : {}),
    ...(item.reportType ? { reportType: item.reportType } : {}),
    ...(item.bookTitle ? { bookTitle: item.bookTitle } : {}),
    ...(item.proceedingsTitle
      ? { proceedingsTitle: item.proceedingsTitle }
      : {}),
    ...(item.conferenceName ? { conferenceName: item.conferenceName } : {}),
    ...(item.eventPlace ? { eventPlace: item.eventPlace } : {}),
    ...(item.numPages
      ? {
          numPages: Number(item.numPages) || item.numPages,
          numberOfPages: Number(item.numPages) || item.numPages,
        }
      : {}),
    ...(item.numberOfVolumes ? { numberOfVolumes: item.numberOfVolumes } : {}),
    ...(item.seriesNumber ? { seriesNumber: item.seriesNumber } : {}),
    ...(item.chapter ? { chapter: item.chapter } : {}),
  };

  return {
    title: item.title,
    shortTitle: item.shortTitle,
    itemType: item.itemType,
    authors: item.authors,
    editors: item.editors,
    creators: item.creators,
    year: item.year,
    publicationDate: item.publicationDate,
    publicationTitle: item.journal || item.proceedingsTitle || item.bookTitle,
    journal: item.journal,
    journalAbbr: item.journalAbbr,
    publisher: item.publisher || item.university || item.institution,
    university: item.university,
    institution: item.institution,
    thesisType: item.thesisType,
    reportNumber: item.reportNumber,
    reportType: item.reportType,
    bookTitle: item.bookTitle,
    proceedingsTitle: item.proceedingsTitle,
    conferenceName: item.conferenceName,
    eventPlace: item.eventPlace,
    place: item.place,
    volume: item.volume,
    issue: item.issue,
    pages: item.pages,
    numPages: item.numPages,
    numberOfPages: item.numPages
      ? Number(item.numPages) || undefined
      : undefined,
    numberOfVolumes: item.numberOfVolumes,
    series: item.series,
    seriesNumber: item.seriesNumber,
    chapter: item.chapter,
    edition: item.edition,
    arxivId: item.arxivId,
    doi: item.doi,
    pmid: item.pmid,
    pmcid: item.pmcid,
    isbn: item.isbn,
    issn: item.issn,
    url: item.url,
    accessedAt: item.accessedAt,
    abstract: item.abstract,
    citationKey: item.citationKey,
    tags: item.keywords,
    keywords: item.keywords,
    notes: Array.isArray(item.notes)
      ? (item.notes as string[]).map((n: string) => ({
          content: n,
          source: 'bibtex',
        }))
      : undefined,
    language: item.language,
    rights: item.rights,
    fileUrl: item.fileUrl,
    extra: item.extra,
    extraFields: Object.keys(extraFields).length > 0 ? extraFields : undefined,
    seeAlso: item.seeAlso,
    relations: item.relations,
  };
}

/**
 * High-performance, zero-dependency Bloom Filter for instant 0ms pre-screening of Retraction DOIs and PMIDs.
 *
 * Mathematical properties:
 * Given n elements and false positive probability p:
 *   m = - (n * ln(p)) / (ln(2)^2)   (bits required)
 *   k = (m / n) * ln(2)             (optimal hash functions)
 *
 * For n = 60,000 retraction records and p = 0.01 (1% false positive):
 *   m = 575,103 bits (~71.8 KB of RAM)
 *   k = 7 hash functions
 *
 * Guaranteed invariant:
 * - Zero False Negatives: If contains() returns FALSE, the DOI is 100% NOT in the retraction database.
 * - Minimal False Positives (1%): If contains() returns TRUE, we confirm with Redis / PostgreSQL.
 */
export class RetractionBloomFilter {
  private readonly sizeBits: number;
  private readonly numHashes: number;
  private readonly bitArray: Uint8Array;
  private itemCount = 0;
  private ready = false;

  constructor(expectedItems = 60000, falsePositiveRate = 0.01) {
    const p = Math.max(0.0001, Math.min(0.1, falsePositiveRate));
    const n = Math.max(1000, expectedItems);

    const m = Math.ceil(-((n * Math.log(p)) / (Math.LN2 * Math.LN2)));
    this.sizeBits = m;
    this.numHashes = Math.max(2, Math.round((m / n) * Math.LN2));
    this.bitArray = new Uint8Array(Math.ceil(m / 8));
  }

  /**
   * 32-bit FNV-1a Hash function
   */
  public static fnv1a(str: string, seed = 0x811c9dc5): number {
    let hash = seed;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
  }

  /**
   * 32-bit Murmur-inspired bit mixer
   */
  private static murmurMix(hash: number): number {
    let h = hash;
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
  }

  /**
   * Kirsch-Mitzenmacher Double-Hashing technique:
   * Generates k distinct hash indexes using only two hash calculations:
   *   g_i(x) = (h1(x) + i * h2(x)) mod m
   */
  private getHashIndexes(key: string): number[] {
    const h1 = RetractionBloomFilter.fnv1a(key, 0x811c9dc5);
    const h2 =
      RetractionBloomFilter.murmurMix(
        RetractionBloomFilter.fnv1a(key, 0x9e3779b9),
      ) | 1; // ensure odd number to cover full bit range

    const indexes: number[] = new Array(this.numHashes);
    for (let i = 0; i < this.numHashes; i++) {
      const combined = (h1 + Math.imul(i, h2)) >>> 0;
      indexes[i] = combined % this.sizeBits;
    }
    return indexes;
  }

  /**
   * Adds a normalized DOI or PMID to the Bloom Filter
   */
  add(key: string): void {
    if (!key) return;
    const cleanKey = key.trim().toLowerCase();
    if (!cleanKey) return;
    const indexes = this.getHashIndexes(cleanKey);

    for (let i = 0; i < indexes.length; i++) {
      const idx = indexes[i];
      const byteIdx = idx >> 3;
      const bitMask = 1 << (idx & 7);
      this.bitArray[byteIdx] |= bitMask;
    }
    this.itemCount++;
  }

  /**
   * Tests whether a key MIGHT be in the set, or is DEFINITELY NOT in the set.
   * Returns:
   *   false => Definitely not retracted (100% confident, 0ms fast path)
   *   true  => Possibly retracted (verify with PostgreSQL)
   */
  contains(key: string): boolean {
    if (!key) return false;
    const cleanKey = key.trim().toLowerCase();
    if (!cleanKey) return false;
    const indexes = this.getHashIndexes(cleanKey);

    for (let i = 0; i < indexes.length; i++) {
      const idx = indexes[i];
      const byteIdx = idx >> 3;
      const bitMask = 1 << (idx & 7);
      if ((this.bitArray[byteIdx] & bitMask) === 0) {
        return false;
      }
    }
    return true;
  }

  /**
   * Resets all bits in the Bloom Filter
   */
  clear(): void {
    this.bitArray.fill(0);
    this.itemCount = 0;
    this.ready = false;
  }

  markReady(isReady = true): void {
    this.ready = isReady;
  }

  isReady(): boolean {
    return this.ready && this.itemCount > 0;
  }

  getItemCount(): number {
    return this.itemCount;
  }

  getMemorySizeBytes(): number {
    return this.bitArray.byteLength;
  }
}
