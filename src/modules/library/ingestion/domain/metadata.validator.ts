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
  if (!title) return null;

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

export interface MetadataQualityEvaluation {
  score: number; // 0 - 100
  level: 'complete' | 'adequate' | 'minimal';
  missingKeyFields: string[];
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
  let presentCount = 0;
  let totalScore = 0;

  // 1. Title (25 pts)
  const hasTitle = Boolean(
    typeof item.title === 'string' && item.title.trim().length > 0,
  );
  if (hasTitle) {
    totalScore += 25;
    presentCount++;
  } else {
    missingKeyFields.push('title');
  }

  // 2. Creators / Authors (25 pts)
  const hasAuthors = Boolean(
    (Array.isArray(item.creators) && item.creators.length > 0) ||
      (Array.isArray(item.authors) && item.authors.length > 0) ||
      (Array.isArray(item.contributors) && item.contributors.length > 0),
  );
  if (hasAuthors) {
    totalScore += 25;
    presentCount++;
  } else {
    missingKeyFields.push('authors');
  }

  // 3. Date / Year (15 pts)
  const hasYear = Boolean(item.year || item.publicationDate || item.date);
  if (hasYear) {
    totalScore += 15;
    presentCount++;
  } else {
    missingKeyFields.push('year');
  }

  // 4. Identifier (15 pts)
  const hasDoi = Boolean(item.doi);
  const hasIdentifier = Boolean(
    hasDoi ||
      item.isbn ||
      item.issn ||
      item.arxivId ||
      item.pmid ||
      item.url,
  );
  if (hasIdentifier) {
    totalScore += 15;
    presentCount++;
  } else {
    missingKeyFields.push('identifier');
  }

  // 5. Context / Venue (10 pts)
  const hasContext = Boolean(
    item.publicationTitle ||
      item.journal ||
      item.publisher ||
      item.bookTitle ||
      item.proceedingsTitle ||
      item.conferenceName,
  );
  if (hasContext) {
    totalScore += 10;
    presentCount++;
  }

  // 6. Abstract (5 pts, or +10 bonus when no type-specific keys are evaluated)
  const hasAbstract = Boolean(item.abstract || item.abstractNote);
  if (hasAbstract) {
    totalScore += options?.typeSpecificKeys?.length ? 5 : 10;
    presentCount++;
  } else {
    missingKeyFields.push('abstract');
  }

  // 7. Optional type-specific fields (5 pts)
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
    presentFieldsCount: presentCount,
    hasTitle,
    hasAuthors,
    hasYear,
    hasIdentifier,
    hasDoi,
    hasContext,
    hasAbstract,
  };
}

