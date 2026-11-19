const NON_PROJECT_SCOPE_KEYWORDS = new Set([
  'me',
  'user',
  'personal',
  'all',
  'undefined',
  'null',
  'default',
  'flux',
]);

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(value?: string | null): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value.trim());
}

export function normalizeScopeAlias(
  value: unknown,
  userId?: string | null,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || NON_PROJECT_SCOPE_KEYWORDS.has(trimmed.toLowerCase())) {
    return undefined;
  }
  if (userId && trimmed.toLowerCase() === userId.trim().toLowerCase()) {
    return undefined;
  }
  return trimmed;
}
