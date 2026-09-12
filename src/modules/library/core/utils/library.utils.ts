/**
 * Pure Utility Functions for Flux Library Domain
 */

/**
 * Normalizes a raw DOI string by stripping URL prefixes, resolvers, and protocol headers.
 */
export function cleanDoi(doi?: string | null): string | null {
  if (!doi) return null;
  const trimmed = doi.trim();
  if (!trimmed) return null;

  return trimmed
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .replace(/^info:doi\//i, '')
    .trim();
}

/**
 * Generates an alphanumeric citation key adhering to Better BibTeX / CSL standards.
 * Format: [first_author_lastname]_[year]_[first_title_word]
 */
export function generateCitationKey(item: {
  contributors?: Array<{ fullName?: string | null; lastName?: string | null }>;
  creators?: Array<{ name?: string | null; lastName?: string | null; firstName?: string | null }>;
  year?: number | string | null;
  date?: string | null;
  title?: string | null;
}): string {
  // Extract primary author lastname
  let author = 'unknown';
  if (item.contributors && item.contributors.length > 0) {
    const first = item.contributors[0];
    author = first.lastName || first.fullName?.trim().split(/\s+/).pop() || 'unknown';
  } else if (item.creators && item.creators.length > 0) {
    const first = item.creators[0];
    author = first.lastName || first.name?.trim().split(/\s+/).pop() || 'unknown';
  }

  const cleanAuthor = author
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z]/g, '')
    .toLowerCase() || 'author';

  // Extract 4-digit year
  let year = 'nodate';
  if (item.year) {
    const match = String(item.year).match(/\b(19\d{2}|20\d{2})\b/);
    if (match) year = match[1];
  } else if (item.date) {
    const match = String(item.date).match(/\b(19\d{2}|20\d{2})\b/);
    if (match) year = match[1];
  }

  // Extract first significant title word
  const stopWords = new Set(['a', 'an', 'the', 'on', 'in', 'at', 'of', 'for', 'to', 'and', 'with', 'by']);
  const titleWords = (item.title || 'untitled')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9\s]/g, '')
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w && !stopWords.has(w));

  const firstTitleWord = titleWords[0] || 'work';

  return `${cleanAuthor}_${year}_${firstTitleWord}`;
}

/**
 * Normalizes title string for duplicate matching and indexing
 */
export function normalizeItemTitle(title?: string | null): string {
  if (!title) return '';
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extracts 4-digit year from ISO date or human readable date string
 */
export function extractYearFromDate(dateStr?: string | null): number | null {
  if (!dateStr) return null;
  const match = String(dateStr).match(/\b(19\d{2}|20\d{2})\b/);
  return match ? parseInt(match[1], 10) : null;
}
