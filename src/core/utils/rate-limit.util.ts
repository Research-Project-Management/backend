export function isSensitiveAuthRoute(rawUrl?: string): boolean {
  if (!rawUrl) return false;

  const path = rawUrl.split('?')[0].split('#')[0];

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
