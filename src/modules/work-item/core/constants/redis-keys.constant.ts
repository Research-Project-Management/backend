/**
 * Redis Key Namespaces for WorkItem Module
 *
 * Standardized according to redis-core colon key conventions:
 * flux:wi:{entity}:{identifier}
 */

export const WORK_ITEM_REDIS_KEYS = {
  /**
   * Project work-items board list (String/JSON array, TTL 30m)
   */
  projectWorkItems: (projectId: string) => `flux:wi:work-items:${projectId}`,

  /**
   * Work-item aggregate details by ID (String/JSON, TTL 1h)
   */
  workItem: (workItemId: string) => `flux:wi:work-item:${workItemId}`,

  /**
   * Project sprint cycles list (String/JSON array, TTL 1h)
   */
  projectCycles: (projectId: string) => `flux:wi:cycles:${projectId}`,

  /**
   * Sprint cycle aggregate details by ID (String/JSON, TTL 30m)
   */
  cycle: (cycleId: string) => `flux:wi:cycle:${cycleId}`,

  /**
   * User / Scope labels list (JSON array, TTL 1h)
   */
  labels: (scopeId: string) => `flux:wi:labels:${scopeId}`,

  /**
   * Project labels list (JSON array, TTL 1h)
   */
  projectLabels: (projectId: string) => `flux:wi:labels:proj:${projectId}`,
  WorkItem: (workItemId: string) => `flux:wi:work-item:${workItemId}`,
} as const;

/**
 * Backward compatibility alias
 */
export const WORKFLOW_REDIS_KEYS = WORK_ITEM_REDIS_KEYS;
