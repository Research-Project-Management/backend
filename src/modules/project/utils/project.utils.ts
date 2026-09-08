/**
 * Project Domain Utilities
 *
 * Pure, stateless functions for project identifier formatting, slug generation, and validation.
 */

/**
 * Formats a project prefix identifier (e.g., 'RES' -> 'RES-101').
 */
export function formatProjectTaskIdentifier(
  prefix: string,
  sequenceNumber: number,
): string {
  const cleanPrefix = (prefix || 'TASK').trim().toUpperCase();
  return `${cleanPrefix}-${sequenceNumber}`;
}

/**
 * Validates whether a project prefix conforms to naming conventions (2-10 uppercase alphanumeric chars).
 */
export function isValidProjectPrefix(prefix: string): boolean {
  if (!prefix) return false;
  return /^[A-Z0-9]{2,10}$/.test(prefix.trim());
}

/**
 * Generates a clean URL slug from project name.
 */
export function generateProjectSlug(name: string): string {
  return (name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}
