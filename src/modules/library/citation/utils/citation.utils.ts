import { CitationStyleId } from '../types/citation.types';

const SUPPORTED_STYLES = new Set<string>([
  'apa',
  'apa-7th',
  'ieee',
  'nature',
  'harvard',
  'chicago',
  'chicago-author-date',
  'mla',
  'mla-9th',
  'vancouver',
  'bibtex',
  'ris',
]);

/**
 * Validates whether a given citation style identifier is supported by the engine.
 */
export function isSupportedCitationStyle(
  styleId: string,
): styleId is CitationStyleId {
  return SUPPORTED_STYLES.has(styleId?.toLowerCase());
}

/**
 * Normalizes citation style string with fallback to 'apa-7th'.
 */
export function normalizeCitationStyleId(styleId?: string): CitationStyleId {
  if (!styleId) return 'apa-7th';
  const clean = styleId.toLowerCase().trim();
  return isSupportedCitationStyle(clean) ? clean : 'apa-7th';
}

/**
 * Sanitizes a citation key, removing illegal characters (spaces, commas, braces, special symbols).
 */
export function sanitizeCitationKey(key?: string | null): string {
  if (!key) return '';
  return key.replace(/[^\w\d_:-]/g, '').trim();
}

/**
 * Generates an automated BibTeX citation key from first author, year, and first title keyword.
 * Example: 'Smith2024Attention'
 */
export function generateDefaultCitationKey(
  authorLastName?: string | null,
  year?: number | null,
  title?: string | null,
): string {
  const authorPart = (authorLastName || 'Unknown').replace(/[^\w]/g, '').trim();
  const yearPart = year ? String(year) : '';
  const firstWord =
    (title || '')
      .split(/\s+/)
      .map((w) => w.replace(/[^\w]/g, ''))
      .find((w) => w.length > 3) || 'Paper';

  return `${authorPart}${yearPart}${firstWord}`;
}
