/**
 * Pure domain utilities for CSL Citation Styles.
 */

export const DEFAULT_CITATION_STYLE = 'apa';

export function normalizeCitationStyle(
  style: string | null | undefined,
): string {
  if (!style || !style.trim()) return DEFAULT_CITATION_STYLE;
  return style.trim().toLowerCase();
}

export function isValidCitationStyleSlug(
  style: string | null | undefined,
): boolean {
  if (!style) return false;
  return /^[a-z0-9-]+$/.test(style.trim().toLowerCase());
}

/**
 * Domain Value Object for validated CSL Citation Styles.
 */
export class CitationStyleVo {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }

  static create(rawStyle?: string | null): CitationStyleVo {
    return new CitationStyleVo(normalizeCitationStyle(rawStyle));
  }
}
