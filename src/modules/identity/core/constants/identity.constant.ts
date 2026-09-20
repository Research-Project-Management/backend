/**
 * Redis cache key definitions for Identity & Authentication domain.
 * Provides consistent key formatting with TTLs for sessions and rate-limiting.
 */
export const IDENTITY_REDIS_KEYS = {
  /** Active session cache: identity:session:{sessionId} */
  session: (sessionId: string): string => `identity:session:${sessionId}`,

  /** User blacklist/revocation marker: identity:revoked:{userId} */
  revoked: (userId: string): string => `identity:revoked:${userId}`,

  /** OAuth state CSRF verification token: identity:oauth:state:{state} */
  oauthState: (state: string): string => `identity:oauth:state:${state}`,

  /** Password reset token cache: identity:reset:{token} */
  passwordReset: (token: string): string => `identity:reset:${token}`,

  /** Email verification token cache: identity:verify:{token} */
  emailVerify: (token: string): string => `identity:verify:${token}`,

  /** OAuth single-use exchange ticket cache: identity:oauth:ticket:{ticket} */
  oauthTicket: (ticket: string): string => `identity:oauth:ticket:${ticket}`,

  /** Refresh token rotation grace period cache: identity:grace:{tokenHash} */
  graceToken: (tokenHash: string): string => `identity:grace:${tokenHash}`,
} as const;
