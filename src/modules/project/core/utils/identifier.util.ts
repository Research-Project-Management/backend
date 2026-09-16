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
    const clean = identifier
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd')
      .replace(/Đ/g, 'D')
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9_-]/g, '');
    if (clean) return clean;
  }
  if (name && name.trim()) {
    const normalizedName = name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd')
      .replace(/Đ/g, 'D');
    const words = normalizedName.trim().split(/\s+/).filter(Boolean);
    if (words.length >= 2) {
      const acronym = words
        .map((w) => w[0])
        .join('')
        .slice(0, 5)
        .toUpperCase()
        .replace(/[^A-Z0-9_-]/g, '');
      if (acronym.length >= 2) return acronym;
    }
    const clean = normalizedName
      .trim()
      .slice(0, 4)
      .toUpperCase()
      .replace(/[^A-Z0-9_-]/g, '');
    if (clean) return clean;
  }
  return 'PROJ';
}

export const isValidProjectPrefix = isValidPrefix;
