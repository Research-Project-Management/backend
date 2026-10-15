/**
 * Pure domain utilities for BibTeX / CSL citation keys.
 */

const CITATION_KEY_REGEX = /^[a-zA-Z0-9_\-.:+]+$/;

export function isValidCitationKey(key: string | null | undefined): boolean {
  if (!key) return false;
  return CITATION_KEY_REGEX.test(key.trim());
}

export function sanitizeCitationKey(key: string | null | undefined): string {
  if (!key) return '';
  return key
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_\-.:+]/g, '');
}
