/**
 * Redis Key Namespaces for Activity Module
 *
 * Standardized according to redis-core colon key conventions:
 * flux:activity:{scope}:{identifier}:feed
 */

export const ACTIVITY_REDIS_KEYS = {
  /**
   * Workspace activity feed (JSON array, TTL 5m)
   */
  workspaceFeed: (workspaceId: string) =>
    `flux:activity:ws:${workspaceId}:feed`,

  /**
   * Project activity feed (JSON array, TTL 5m)
   */
  projectFeed: (projectId: string) => `flux:activity:proj:${projectId}:feed`,

  /**
   * Entity changelog / history (JSON array, TTL 30m)
   */
  entityFeed: (entityType: string, entityId: string) =>
    `flux:activity:entity:${entityType}:${entityId}`,

  /**
   * Actor personal recent timeline (JSON array, TTL 10m)
   */
  userRecent: (userId: string) => `flux:activity:user:${userId}:recent`,
} as const;
