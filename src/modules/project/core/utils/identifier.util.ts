/**
 * Identifier and WorkItem Code Utilities for Project Module
 */

/**
 * Formats a project prefix identifier (e.g., 'RES' -> 'RES-101').
 */
export function formatWorkItemCode(
  prefix: string,
  sequenceNumber: number,
): string {
  const cleanPrefix = (prefix || 'WI').trim().toUpperCase();
  return `${cleanPrefix}-${sequenceNumber}`;
}

/**
 * Validates whether a prefix conforms to naming conventions (2-10 uppercase alphanumeric chars).
 */
export function isValidPrefix(prefix: string): boolean {
  if (!prefix) return false;
  return /^[A-Z0-9_-]{2,10}$/.test(prefix.trim());
}

/**
 * Derives a project identifier prefix from the project's identifier code or name.
 */
export function deriveProjectPrefix(
  identifier?: string | null,
  name?: string | null,
): string {
  if (identifier && identifier.trim()) {
    return identifier.trim().toUpperCase();
  }
  if (name && name.trim()) {
    const words = name.trim().split(/\s+/);
    if (words.length >= 2) {
      const acronym = words
        .map((w) => w[0])
        .join('')
        .slice(0, 5)
        .toUpperCase();
      if (acronym.length >= 2) return acronym;
    }
    return name.trim().slice(0, 4).toUpperCase();
  }
  return 'PROJ';
}

export const isValidProjectPrefix = isValidPrefix;
