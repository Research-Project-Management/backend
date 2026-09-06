/**
 * Workspace Domain Utilities
 *
 * Pure, stateless functions for slug generation, URL validation, and workspace formatting.
 */

/**
 * Generates a clean URL slug from workspace name or custom input.
 */
export function generateWorkspaceSlug(
  name: string,
  overrideSlug?: string | null,
  overrideUrl?: string | null,
): string {
  const source = (overrideSlug || overrideUrl || name || '').trim();
  return source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

/**
 * Validates if a workspace slug matches allowed URL character pattern.
 */
export function isValidWorkspaceSlug(slug: string): boolean {
  if (!slug || slug.length < 2 || slug.length > 64) {
    return false;
  }
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
}

/**
 * Sanitizes workspace display name.
 */
export function sanitizeWorkspaceName(name: string): string {
  return (name || '').trim().replace(/\s+/g, ' ');
}
