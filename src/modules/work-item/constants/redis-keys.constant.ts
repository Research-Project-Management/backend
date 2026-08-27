/**
 * Redis Key Namespaces for WorkItem Module
 *
 * Standardized according to redis-core colon key conventions:
 * flux:wi:{entity}:{identifier}
 */

export const WORK_ITEM_REDIS_KEYS = {
  /**
   * Project tasks/work-items board list (String/JSON array, TTL 30m)
   */
  projectTasks: (projectId: string) => `flux:wi:tasks:${projectId}`,

  /**
   * Work-item aggregate details by ID (String/JSON, TTL 1h)
   */
  task: (taskId: string) => `flux:wi:task:${taskId}`,

  /**
   * Project sprint cycles list (String/JSON array, TTL 1h)
   */
  projectCycles: (projectId: string) => `flux:wi:cycles:${projectId}`,

  /**
   * Sprint cycle aggregate details by ID (String/JSON, TTL 30m)
   */
  cycle: (cycleId: string) => `flux:wi:cycle:${cycleId}`,

  /**
   * Project daily worklogs by date (String/JSON, TTL 15m)
   */
  projectWorklogs: (projectId: string, dateStr: string) =>
    `flux:wi:worklogs:${projectId}:${dateStr}`,
} as const;

/**
 * Backward compatibility alias
 */
export const WORKFLOW_REDIS_KEYS = WORK_ITEM_REDIS_KEYS;
