/**
 * Slug Utilities for Project Module
 */

/**
 * Generates a clean URL slug from project name.
 */
export function generateSlug(name: string): string {
  return (name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

export const generateProjectSlug = generateSlug;
