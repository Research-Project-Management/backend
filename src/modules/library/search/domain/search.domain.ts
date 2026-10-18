import { SearchQuery } from '@/modules/library/search/types/search.types';

/**
 * Sanitizes search input to prevent SQL injection or tsquery syntax breaking.
 */
export function sanitizeSearchQuery(query?: string): string {
  if (!query) return '';
  return query
    .replace(/['":*&|!()\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalizes and clamps search query parameters into a valid SearchQuery contract.
 */
export function createSearchQuery(
  rawQuery: string,
  options?: { limit?: number; offset?: number; sortBy?: string },
): SearchQuery {
  const trimmed = (rawQuery ?? '').trim();
  const limit = Math.min(100, Math.max(1, options?.limit ?? 20));
  const offset = Math.max(0, options?.offset ?? 0);
  const sortBy =
    options?.sortBy === 'date' || options?.sortBy === 'title'
      ? options.sortBy
      : 'relevance';

  return {
    query: trimmed,
    limit,
    offset,
    sortBy,
  };
}
