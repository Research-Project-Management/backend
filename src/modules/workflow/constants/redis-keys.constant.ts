/**
 * Redis Key Namespaces for Workflow Module
 *
 * Standardized according to redis-core colon key conventions:
 * flux:wf:{entity}:{identifier}
 */

export const WORKFLOW_REDIS_KEYS = {
  /**
   * Project tasks board list (String/JSON array, TTL 30m)
   */
  projectTasks: (projectId: string) => `flux:wf:tasks:${projectId}`,

  /**
   * Task aggregate details by ID (String/JSON, TTL 1h)
   */
  task: (taskId: string) => `flux:wf:task:${taskId}`,

  /**
   * Project sprint cycles list (String/JSON array, TTL 1h)
   */
  projectCycles: (projectId: string) => `flux:wf:cycles:${projectId}`,

  /**
   * Sprint cycle aggregate details by ID (String/JSON, TTL 30m)
   */
  cycle: (cycleId: string) => `flux:wf:cycle:${cycleId}`,

  /**
   * Project daily worklogs by date (String/JSON, TTL 15m)
   */
  projectWorklogs: (projectId: string, dateStr: string) =>
    `flux:wf:worklogs:${projectId}:${dateStr}`,
} as const;
