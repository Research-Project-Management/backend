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
