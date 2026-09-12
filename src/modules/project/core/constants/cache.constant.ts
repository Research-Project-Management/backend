/**
 * Cache Key Namespaces and TTL for Project Module
 *
 * Pattern: flux:proj:{entity}:{identifier}
 */

export const CACHE_KEYS = {
  /**
   * Project full details by ID (TTL 1h)
   */
  detail: (projectId: string) => `flux:proj:${projectId}`,

  /**
   * List of active projects for a user (TTL 15m)
   */
  userProjects: (userId: string) => `flux:proj:user:${userId}`,

  /**
   * Project aggregated dashboard overview stats (TTL 15m)
   */
  overview: (projectId: string) => `flux:proj:overview:${projectId}`,
} as const;

export const CACHE_TTL_SECONDS = {
  DETAIL: 3600, // 1 hour
  USER_PROJECTS: 900, // 15 mins
  OVERVIEW: 900, // 15 mins
} as const;

// Backwards-compatible alias
export const PROJECT_REDIS_KEYS = CACHE_KEYS;
