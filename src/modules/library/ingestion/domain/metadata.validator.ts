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

export interface IBibliographicQualityRule {
  readonly id:
    | 'title'
    | 'authors'
    | 'year'
    | 'identifier'
    | 'doi'
    | 'context'
    | 'abstract';
  readonly fieldKey?: string;
  readonly issueCode?: string;
  readonly weight: number;
  isSatisfied(item: Record<string, unknown>): boolean;
}

export const BIBLIOGRAPHIC_QUALITY_RULES: readonly IBibliographicQualityRule[] =
  [
    {
      id: 'title',
      fieldKey: 'title',
      issueCode: 'missing_title',
      weight: 25,
      isSatisfied(item: Record<string, unknown>): boolean {
        return typeof item.title === 'string' && item.title.trim().length > 3;
      },
    },
    {
      id: 'authors',
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
      issueCode: 'missing_doi',
      weight: 0,
      isSatisfied(item: Record<string, unknown>): boolean {
        return Boolean(item.doi && String(item.doi).trim().length > 0);
      },
    },
    {
      id: 'context',
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

  const satisfiedById = new Map<IBibliographicQualityRule['id'], boolean>();

  for (const rule of BIBLIOGRAPHIC_QUALITY_RULES) {
    const satisfied = rule.isSatisfied(item);
    satisfiedById.set(rule.id, satisfied);

    if (satisfied) {
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
    hasTitle: Boolean(satisfiedById.get('title')),
    hasAuthors: Boolean(satisfiedById.get('authors')),
    hasYear: Boolean(satisfiedById.get('year')),
    hasIdentifier: Boolean(satisfiedById.get('identifier')),
    hasDoi: Boolean(satisfiedById.get('doi')),
    hasContext: Boolean(satisfiedById.get('context')),
    hasAbstract: Boolean(satisfiedById.get('abstract')),
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
