import * as crypto from 'crypto';

/**
 * Computes SHA-256 hex digest for opaque refresh tokens.
 */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Extracts raw Bearer token from authorization header string.
 */
export function extractBearerToken(authHeader?: string): string | null {
  if (!authHeader) return null;
  const [type, token] = authHeader.split(' ');
  return type?.toLowerCase() === 'bearer' && token ? token.trim() : null;
}

/**
 * Checks if a JWT exp timestamp (in seconds) has passed.
 */
export function isTokenExpired(exp?: number): boolean {
  if (!exp) return false;
  return Date.now() >= exp * 1000;
}
