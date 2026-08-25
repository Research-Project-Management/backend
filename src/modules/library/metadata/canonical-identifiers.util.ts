/**
 * Canonical Identifier Normalization Utilities
 *
 * Implements deterministic cleaning, formatting, and canonical scheme prefixing
 * for all scholarly persistent identifiers (PIDs): DOI, arXiv ID, PMID, PMCID, ISBN, ISSN.
 */

/**
 * Normalizes DOI strings:
 * - Strips URL prefixes (https://doi.org/, http://dx.doi.org/)
 * - Strips 'doi:' prefix
 * - Normalizes to trimmed, lowercased directory part (10.xxxx/...)
 */
export function normalizeDoi(doi?: string | null): string | undefined {
  if (!doi || typeof doi !== 'string') return undefined;
  const cleaned = doi
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .trim();

  // Valid DOI must start with '10.' followed by registrant code and suffix
  if (/^10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+$/i.test(cleaned)) {
    return cleaned.toLowerCase();
  }
  return cleaned.length > 3 ? cleaned : undefined;
}

/**
 * Normalizes arXiv identifiers:
 * - Strips URL prefixes (https://arxiv.org/abs/, https://arxiv.org/pdf/)
 * - Strips 'arxiv:' prefix
 * - Strips version suffix (e.g. v1, v2) for canonical identification
 */
export function normalizeArxivId(
  arxivId?: string | null,
  options: { stripVersion?: boolean } = { stripVersion: false },
): string | undefined {
  if (!arxivId || typeof arxivId !== 'string') return undefined;
  let cleaned = arxivId
    .trim()
    .replace(/^https?:\/\/arxiv\.org\/(?:abs|pdf)\//i, '')
    .replace(/\.pdf$/i, '')
    .replace(/^arxiv:\s*/i, '')
    .trim();

  if (options.stripVersion) {
    cleaned = cleaned.replace(/v\d+$/i, '');
  }

  // Matches new format: YYMM.NNNNN (e.g. 1706.03762) or legacy format: math/0001001
  if (
    /^\d{4}\.\d{4,5}(?:v\d+)?$/i.test(cleaned) ||
    /^[a-z\-]+(?:\.[a-z]{2})?\/\d{7}(?:v\d+)?$/i.test(cleaned)
  ) {
    return cleaned;
  }
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Normalizes PubMed ID (PMID):
 * - Strips URL prefixes and 'pmid:' prefix
 * - Keeps digits only
 */
export function normalizePmid(pmid?: string | null): string | undefined {
  if (!pmid || typeof pmid !== 'string') return undefined;
  const cleaned = pmid
    .trim()
    .replace(/^https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\//i, '')
    .replace(/\/?$/, '')
    .replace(/^pmid:?\s*/i, '')
    .replace(/\D/g, '')
    .trim();

  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Normalizes PubMed Central ID (PMCID):
 * - Strips URL prefixes and 'pmcid:' prefix
 * - Standardizes prefix to uppercase 'PMC' followed by digits
 */
export function normalizePmcid(pmcid?: string | null): string | undefined {
  if (!pmcid || typeof pmcid !== 'string') return undefined;
  const cleaned = pmcid
    .trim()
    .replace(/^https?:\/\/(?:www\.)?ncbi\.nlm\.nih\.gov\/pmc\/articles\//i, '')
    .replace(/\/?$/, '')
    .replace(/^pmcid:?\s*/i, '')
    .trim();

  const digits = cleaned.replace(/^PMC/i, '').replace(/\D/g, '');
  if (digits.length > 0) {
    return `PMC${digits}`;
  }
  return undefined;
}

/**
 * Normalizes International Standard Book Number (ISBN):
 * - Strips hyphens, spaces, and 'isbn:' prefix
 * - Validates length 10 or 13
 */
export function normalizeIsbn(isbn?: string | null): string | undefined {
  if (!isbn || typeof isbn !== 'string') return undefined;
  const cleaned = isbn
    .trim()
    .replace(/^isbn(?:-1[03])?:?\s*/i, '')
    .replace(/[^0-9X]/gi, '')
    .trim()
    .toUpperCase();

  if (cleaned.length === 10 || cleaned.length === 13) {
    return cleaned;
  }
  return undefined;
}

/**
 * Normalizes International Standard Serial Number (ISSN):
 * - Strips 'issn:' prefix, spaces
 * - Standardizes format to XXXX-XXXX (8 characters with hyphen)
 */
export function normalizeIssn(issn?: string | null): string | undefined {
  if (!issn || typeof issn !== 'string') return undefined;
  const cleaned = issn
    .trim()
    .replace(/^issn:?\s*/i, '')
    .replace(/[^0-9X]/gi, '')
    .trim()
    .toUpperCase();

  if (cleaned.length === 8) {
    return `${cleaned.slice(0, 4)}-${cleaned.slice(4)}`;
  }
  return undefined;
}

/**
 * Formats a canonical URI/URN for any scholarly identifier:
 * e.g., 'doi:10.1038/nature12345', 'arxiv:1706.03762', 'pmid:29124373', 'isbn:9780262033848'
 */
export function formatCanonicalId(
  scheme: 'doi' | 'arxiv' | 'pmid' | 'pmcid' | 'isbn' | 'issn' | 'url' | string,
  value: string,
): string {
  const normScheme = scheme.toLowerCase().trim();
  switch (normScheme) {
    case 'doi': {
      const v = normalizeDoi(value);
      return v ? `doi:${v}` : value;
    }
    case 'arxiv': {
      const v = normalizeArxivId(value);
      return v ? `arxiv:${v}` : value;
    }
    case 'pmid': {
      const v = normalizePmid(value);
      return v ? `pmid:${v}` : value;
    }
    case 'pmcid': {
      const v = normalizePmcid(value);
      return v ? `pmcid:${v}` : value;
    }
    case 'isbn': {
      const v = normalizeIsbn(value);
      return v ? `isbn:${v}` : value;
    }
    case 'issn': {
      const v = normalizeIssn(value);
      return v ? `issn:${v}` : value;
    }
    default:
      return `${normScheme}:${value.trim()}`;
  }
}
