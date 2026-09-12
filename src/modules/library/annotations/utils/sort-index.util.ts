/**
 * Sort index utilities for Annotation ordering.
 *
 * Implements Zotero-compatible annotation sort key:
 *   Format: "PPPP|YYYYY|XXXXX"
 *   P = zero-padded page index (4 digits)
 *   Y = zero-padded Y coordinate * 10000 (5 digits, page-relative [0,1])
 *   X = zero-padded X coordinate * 10000 (5 digits, page-relative [0,1])
 *
 * Sort order: page ascending → top of page → left of page
 * (Y increases downward, so lower Y = higher on page = sorts first)
 */

/** Maximum value for coordinate component (1.0 * 10000) */
const COORD_SCALE = 10_000;
const PAGE_PAD    = 4;
const COORD_PAD   = 5;

/**
 * Build a Zotero-compatible annotation sort index string.
 *
 * @param pageIndex - 0-based page number
 * @param y         - Y position in [0, 1] page-relative coordinates (0 = top). Default 0.
 * @param x         - X position in [0, 1] page-relative coordinates (0 = left). Default 0.
 */
export function buildAnnotationSortIndex(
  pageIndex: number,
  y = 0,
  x = 0,
): string {
  const p  = String(Math.max(0, Math.round(pageIndex))).padStart(PAGE_PAD, '0');
  const yy = String(Math.max(0, Math.round(y * COORD_SCALE))).padStart(COORD_PAD, '0');
  const xx = String(Math.max(0, Math.round(x * COORD_SCALE))).padStart(COORD_PAD, '0');
  return `${p}|${yy}|${xx}`;
}

// ─── Parsed shape ─────────────────────────────────────────────────────────────

export interface ParsedSortIndex {
  page:  number;
  y:     number;
  x:     number;
}

/**
 * Parse a sort index string back into its components.
 * Returns null if the format is invalid.
 */
export function parseAnnotationSortIndex(
  sortIndex: string,
): ParsedSortIndex | null {
  const parts = sortIndex.split('|');
  if (parts.length !== 3) return null;

  const [p, yy, xx] = parts.map(Number);
  if ([p, yy, xx].some(isNaN)) return null;

  return {
    page: p,
    y:    yy / COORD_SCALE,
    x:    xx / COORD_SCALE,
  };
}

/**
 * Compare two sort index strings lexicographically.
 * Suitable for use as Array.prototype.sort comparator.
 */
export function compareSortIndex(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
