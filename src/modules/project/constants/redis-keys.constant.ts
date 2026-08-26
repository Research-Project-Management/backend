/**
 * Redis Key Namespaces for Project Module
 *
 * Standardized according to redis-core colon key conventions:
 * flux:proj:{entity}:{identifier}
 */

export const PROJECT_REDIS_KEYS = {
  /**
   * Project full details by ID (String/JSON, TTL 1h)
   */
  project: (projectId: string) => `flux:proj:${projectId}`,

  /**
   * List of active projects for a workspace (String/JSON array, TTL 30m)
   */
  workspaceProjects: (workspaceId: string) =>
    `flux:proj:workspace_projects:${workspaceId}`,

  /**
   * Project aggregated dashboard overview stats (String/JSON, TTL 15m)
   */
  overview: (projectId: string) => `flux:proj:overview:${projectId}`,
} as const;
