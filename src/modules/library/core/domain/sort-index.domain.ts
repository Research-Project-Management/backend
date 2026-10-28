/**
 * Canonical Zotero-compatible Annotation Sort Index Utilities
 * Format: "PPPP|YYYYY|XXXXX"
 *   P = zero-padded page index (4 digits)
 *   Y = zero-padded Y coordinate * 10000 (5 digits, page-relative [0,1])
 *   X = zero-padded X coordinate * 10000 (5 digits, page-relative [0,1])
 *
 * Sort order: page ascending -> top of page -> left of page
 * (Y increases downward, so lower Y = higher on page = sorts first)
 */

export const COORD_SCALE = 10_000;
export const PAGE_PAD = 4;
export const COORD_PAD = 5;
export const MAX_SORT_PAGE = 9_999;
export const MAX_SORT_COORD = 99_999;

export interface ParsedSortIndex {
  page: number;
  y: number;
  x: number;
}

/**
 * Build a Zotero-compatible annotation sort index string.
 */
export function buildAnnotationSortIndex(
  pageIndex: number,
  y = 0,
  x = 0,
): string {
  const safePage = Number.isFinite(pageIndex) ? pageIndex : 0;
  const safeY = Number.isFinite(y) ? y : 0;
  const safeX = Number.isFinite(x) ? x : 0;
  const p = String(
    Math.min(MAX_SORT_PAGE, Math.max(0, Math.round(safePage))),
  ).padStart(PAGE_PAD, '0');
  const yy = String(
    Math.min(MAX_SORT_COORD, Math.max(0, Math.round(safeY * COORD_SCALE))),
  ).padStart(COORD_PAD, '0');
  const xx = String(
    Math.min(MAX_SORT_COORD, Math.max(0, Math.round(safeX * COORD_SCALE))),
  ).padStart(COORD_PAD, '0');
  return `${p}|${yy}|${xx}`;
}

/**
 * Parse a sort index string back into its components.
 * Returns null if the format is invalid.
 */
export function parseAnnotationSortIndex(
  sortIndex?: string | null,
): ParsedSortIndex | null {
  if (!sortIndex) return null;
  const parts = sortIndex.split('|');
  if (parts.length !== 3) return null;

  const [p, yy, xx] = parts.map(Number);
  if ([p, yy, xx].some(isNaN)) return null;

  return {
    page: p,
    y: yy / COORD_SCALE,
    x: xx / COORD_SCALE,
  };
}

/**
 * Compare two sort index strings lexicographically.
 */
export function compareSortIndex(indexA: string, indexB: string): number {
  return indexA < indexB ? -1 : indexA > indexB ? 1 : 0;
}
