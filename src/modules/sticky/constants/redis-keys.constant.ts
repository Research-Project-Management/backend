/**
 * Redis Key Namespaces for Sticky Module
 *
 * Standardized according to redis-core colon key conventions:
 * flux:sticky:{scope}:{identifier}:user:{userId}
 */

export const STICKY_REDIS_KEYS = {
  /**
   * Workspace personal stickies (JSON array, TTL 30m)
   */
  workspaceStickies: (workspaceId: string, userId: string) =>
    `flux:sticky:ws:${workspaceId}:user:${userId}`,

  /**
   * Project personal stickies (JSON array, TTL 30m)
   */
  projectStickies: (projectId: string, userId: string) =>
    `flux:sticky:proj:${projectId}:user:${userId}`,
} as const;
