/**
 * Redis Key Namespaces for Sticky Module
 *
 * Standardized according to redis-core colon key conventions:
 * flux:sticky:{scope}:{identifier}:user:{userId}
 */

export const STICKY_REDIS_KEYS = {
  /**
   * User stickies (JSON array, TTL 30m)
   */
  personalStickies: (userId: string) => `flux:sticky:user:${userId}`,
  userStickies: (userId: string) => `flux:sticky:user:${userId}`,
  projectStickies: (projectId: string) => `flux:sticky:project:${projectId}`,
} as const;
