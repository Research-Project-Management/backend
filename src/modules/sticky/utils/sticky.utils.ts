/**
 * Sticky Note Domain Utilities
 *
 * Pure, stateless functions for color validation and sticky note formatting.
 */

export const ALLOWED_STICKY_COLORS = [
  '#fef08a', // Yellow
  '#bbf7d0', // Green
  '#fed7aa', // Orange
  '#fbcfe8', // Pink
  '#bfdbfe', // Blue
  '#e9d5ff', // Purple
  '#e2e8f0', // Gray
] as const;

export type StickyColor = (typeof ALLOWED_STICKY_COLORS)[number];

/**
 * Validates and normalizes sticky note color. Defaults to classic yellow (#fef08a).
 */
export function normalizeStickyColor(color?: string | null): string {
  if (!color) return '#fef08a';
  const clean = color.trim().toLowerCase();
  return ALLOWED_STICKY_COLORS.includes(clean as StickyColor)
    ? clean
    : '#fef08a';
}

/**
 * Truncates sticky note preview text cleanly.
 */
export function truncateStickyContent(
  content: string,
  maxLength: number = 100,
): string {
  if (!content || content.length <= maxLength) return content || '';
  return `${content.slice(0, maxLength).trim()}...`;
}
