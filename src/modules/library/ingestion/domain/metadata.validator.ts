import {
  ItemMetadata,
  Provenance,
} from '@/modules/library/ingestion/types/metadata.types';
import {
  normalizeDoi,
  normalizeArxivId,
  normalizePmid,
  normalizePmcid,
  normalizeIsbn,
  normalizeIssn,
  normalizeAcademicTags,
} from '@/modules/library/core';

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
    tags: normalizeAcademicTags(raw.tags ?? raw.keywords),
    keywords: normalizeAcademicTags(raw.keywords),
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
