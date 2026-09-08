import { isSensitiveAuthRoute } from '../../src/core/utils/rate-limit.util';

describe('P1 Rate Limit Route Detection', () => {
  it('identifies standard auth endpoints as sensitive', () => {
    expect(isSensitiveAuthRoute('/auth/login')).toBe(true);
    expect(isSensitiveAuthRoute('/auth/register')).toBe(true);
    expect(isSensitiveAuthRoute('/auth/refresh')).toBe(true);
    expect(isSensitiveAuthRoute('/auth/forgot-password')).toBe(true);
    expect(isSensitiveAuthRoute('/auth/reset-password')).toBe(true);
    expect(isSensitiveAuthRoute('/auth/oauth/exchange')).toBe(true);
  });

  it('identifies /api prefixed auth endpoints as sensitive', () => {
    expect(isSensitiveAuthRoute('/api/auth/login')).toBe(true);
    expect(isSensitiveAuthRoute('/api/auth/register')).toBe(true);
    expect(isSensitiveAuthRoute('/api/auth/refresh')).toBe(true);
    expect(isSensitiveAuthRoute('/api/auth/forgot-password')).toBe(true);
    expect(isSensitiveAuthRoute('/api/auth/reset-password')).toBe(true);
    expect(isSensitiveAuthRoute('/api/auth/oauth/exchange')).toBe(true);
  });

  it('handles query parameters and hashes correctly', () => {
    expect(isSensitiveAuthRoute('/auth/login?redirect=/dashboard')).toBe(true);
    expect(isSensitiveAuthRoute('/api/auth/refresh?timestamp=123#token')).toBe(
      true,
    );
  });

  it('does not flag non-sensitive or public informational routes', () => {
    expect(isSensitiveAuthRoute('/auth/google')).toBe(false);
    expect(isSensitiveAuthRoute('/items')).toBe(false);
    expect(isSensitiveAuthRoute('/api/items')).toBe(false);
    expect(isSensitiveAuthRoute('/health')).toBe(false);
    expect(isSensitiveAuthRoute('')).toBe(false);
    expect(isSensitiveAuthRoute(undefined)).toBe(false);
  });
});
