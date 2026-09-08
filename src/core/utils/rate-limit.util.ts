/**
 * Determines whether an incoming request URL targets a sensitive authentication
 * endpoint (login, register, token refresh, password recovery, OAuth exchange).
 * Handles both '/auth/...' and '/api/auth/...' prefixes as well as query strings.
 */
export function isSensitiveAuthRoute(rawUrl?: string): boolean {
  if (!rawUrl) return false;
  // Strip query string and hash
  const path = rawUrl.split('?')[0].split('#')[0];
  // Normalize by stripping /api prefix if present
  const normalized = path.replace(/^\/api(?=\/)/, '');

  return (
    normalized.startsWith('/auth/login') ||
    normalized.startsWith('/auth/register') ||
    normalized.startsWith('/auth/refresh') ||
    normalized.startsWith('/auth/forgot-password') ||
    normalized.startsWith('/auth/reset-password') ||
    normalized.startsWith('/auth/change-password') ||
    normalized.startsWith('/auth/oauth/exchange')
  );
}
