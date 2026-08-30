import { ItemMetadata } from '../types/metadata.types';
import {
  normalizeDoi,
  normalizeArxivId,
  normalizePmid,
  normalizePmcid,
  normalizeIsbn,
  normalizeIssn,
  normalizeTags,
} from '../utils/metadata.utils';

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
          .map((author) => (typeof author === 'string' ? author.trim() : ''))
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

  if (raw.provenance) {
    normalized.provenance = {
      ...raw.provenance,
      resolvedAt: raw.provenance.resolvedAt ?? new Date().toISOString(),
      confidenceScore: raw.provenance.confidenceScore ?? 1,
      isOpenAccess: raw.provenance.isOpenAccess ?? false,
    };
  }

  return normalized;
}

export const validateAcademicMetadata = validateMetadata;
