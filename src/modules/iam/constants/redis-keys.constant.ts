/**
 * Redis Cache Schema & Key Constants for IAM Module
 *
 * Follows the official redis-core colon-separated standard:
 * Pattern: flux:iam:<domain>:<identifier>
 */

export const IAM_REDIS_KEYS = {
  /**
   * Active Session Data
   * Key: flux:iam:session:{sessionId}
   */
  session: (sessionId: string) => `flux:iam:session:${sessionId}` as const,

  /**
   * Set of Active Session IDs per User
   * Key: flux:iam:user_sessions:{userId}
   */
  userSessions: (userId: string) => `flux:iam:user_sessions:${userId}` as const,

  /**
   * Workspace Member Role Cache
   * Key: flux:iam:ws_role:{workspaceId}:{userId}
   * Default TTL: 600s (10 min)
   */
  workspaceRole: (workspaceId: string, userId: string) =>
    `flux:iam:ws_role:${workspaceId}:${userId}` as const,

  /**
   * Project Member Role Cache
   * Key: flux:iam:proj_role:{projectId}:{userId}
   * Default TTL: 600s (10 min)
   */
  projectRole: (projectId: string, userId: string) =>
    `flux:iam:proj_role:${projectId}:${userId}` as const,

  /**
   * OAuth Temporary State & PKCE Nonce
   * Key: flux:iam:oauth_state:{stateToken}
   * TTL: 600s (10 min)
   */
  oauthState: (stateToken: string) =>
    `flux:iam:oauth_state:${stateToken}` as const,

  /**
   * Rate Limit Sliding Window Counter
   * Key: flux:iam:rate_limit:login:{identifier}
   * TTL: 900s (15 min)
   */
  loginRateLimit: (identifier: string) =>
    `flux:iam:rate_limit:login:${identifier}` as const,
};

export interface CachedSessionPayload {
  userId: string;
  familyId: string;
  isValid: boolean;
  expiresAt: string;
  ipAddress?: string;
  userAgent?: string;
}
