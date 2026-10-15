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
  normalizeTags,
} from './metadata.domain';

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

export const validateAcademicMetadata = validateMetadata;
