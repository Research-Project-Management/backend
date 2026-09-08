/**
 * Pure utility functions for curation, deduplication and merging.
 */

/**
 * Normalizes title string for duplicate matching by removing punctuation and lowercasing.
 */
export function normalizeTitleForDedupe(title?: string | null): string {
  if (!title) return '';
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

/**
 * Extracts first author's family/last name from an author string array.
 */
export function extractFirstAuthorFamily(authors?: string[] | null): string {
  if (!authors || authors.length === 0) return '';
  const first = (authors[0] || '').trim().toLowerCase();
  if (first.includes(',')) {
    return first.split(',')[0].trim();
  }
  const parts = first.split(/\s+/);
  return parts[parts.length - 1] || '';
}

/**
 * Extracts normalized author display strings from item contributors.
 */
export function extractContributorAuthors(item: {
  contributors?: Array<{
    firstName?: string;
    lastName?: string;
    fullName?: string;
  }>;
}): string[] {
  if (!item.contributors || item.contributors.length === 0) return [];
  return item.contributors
    .map((c) => c.fullName || `${c.firstName || ''} ${c.lastName || ''}`.trim())
    .filter(Boolean);
}

/**
 * Generates deduplication bucket key from normalized title prefix and first author surname.
 */
export function generateDedupeBucketKey(
  title: string,
  authors: string[],
  titlePrefixLength = 32,
): string {
  const normTitle = normalizeTitleForDedupe(title);
  const authorFamily = extractFirstAuthorFamily(authors);
  return `${normTitle.substring(0, titlePrefixLength)}::${authorFamily}`;
}
