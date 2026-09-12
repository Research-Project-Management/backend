/**
 * Redis cache key definitions for IAM domain.
 * Provides consistent key formatting with TTLs for authorization, sessions, and rate-limiting.
 */
export const IAM_REDIS_KEYS = {
  /** User project role cache: iam:role:{projectId}:{userId} */
  role: (projectId: string, userId: string): string =>
    `iam:role:${projectId}:${userId}`,

  /** User project permissions cache: iam:perms:{projectId}:{userId} */
  permissions: (projectId: string, userId: string): string =>
    `iam:perms:${projectId}:${userId}`,

  /** Active session cache: iam:session:{sessionId} */
  session: (sessionId: string): string => `iam:session:${sessionId}`,

  /** User blacklist/revocation marker: iam:revoked:{userId} */
  revoked: (userId: string): string => `iam:revoked:${userId}`,

  /** OAuth state CSRF verification token: iam:oauth:state:{state} */
  oauthState: (state: string): string => `iam:oauth:state:${state}`,

  /** Password reset token cache: iam:reset:{token} */
  passwordReset: (token: string): string => `iam:reset:${token}`,

  /** Email verification token cache: iam:verify:{token} */
  emailVerify: (token: string): string => `iam:verify:${token}`,
} as const;
