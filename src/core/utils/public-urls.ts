/**
 * Resolves externally visible URLs (API / client) from the environment.
 * Dev fallbacks apply only outside production; production fails fast on a
 * missing value instead of silently emitting localhost redirects.
 */
const DEV_FALLBACKS = {
  API_URL: 'http://localhost:3000',
  CLIENT_URL: 'http://localhost:2915',
} as const;

export type PublicUrlKey = keyof typeof DEV_FALLBACKS;

export function resolvePublicUrl(
  key: PublicUrlKey,
  configured?: string | null,
): string {
  const value = configured?.trim();
  if (value) return value.replace(/\/$/, '');
  if (process.env.NODE_ENV === 'production') {
    throw new Error(`${key} must be configured in production`);
  }
  return DEV_FALLBACKS[key];
}

/**
 * Resolves an infrastructure endpoint (Redis, CLSI, AI engine, ...).
 * The dev default applies only outside production.
 */
export function resolveServiceUrl(
  name: string,
  configured: string | null | undefined,
  devDefault: string,
): string {
  const value = configured?.trim();
  if (value) return value;
  if (process.env.NODE_ENV === 'production') {
    throw new Error(`${name} must be configured in production`);
  }
  return devDefault;
}
