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
   * User / Scope labels list (JSON array, TTL 1h)
   */
  labels: (scopeId: string) => `flux:wi:labels:${scopeId}`,

  /**
   * Project labels list (JSON array, TTL 1h)
   */
  projectLabels: (projectId: string) => `flux:wi:labels:proj:${projectId}`,

  /**
   * Project work-item atomic sequence counter (Integer)
   */
  sequence: (projectId: string) => `flux:wi:seq:${projectId}`,

  /**
   * Project states list
   */
  states: (projectId: string) => `flux:wi:states:${projectId}`,

  /**
   * Project overview cache key
   */
  projectOverview: (projectId: string) => `flux:proj:overview:${projectId}`,

  /**
   * Aliases for cleaner shorthand
   */
  list: (projectId: string) => `flux:wi:work-items:${projectId}`,
  item: (id: string) => `flux:wi:work-item:${id}`,
} as const;

export async function invalidateWorkItemCache(
  cache: { del: (key: string) => Promise<unknown> } | null | undefined,
  options: {
    projectId?: string | null;
    workItemId?: string | null;
    identifier?: string | null;
  },
): Promise<void> {
  if (!cache) return;
  const keys = new Set<string>();
  if (options.projectId) {
    keys.add(WORK_ITEM_REDIS_KEYS.projectWorkItems(options.projectId));
    keys.add(WORK_ITEM_REDIS_KEYS.projectOverview(options.projectId));
  }
  if (options.workItemId) {
    keys.add(WORK_ITEM_REDIS_KEYS.workItem(options.workItemId));
  }
  if (options.identifier) {
    keys.add(WORK_ITEM_REDIS_KEYS.workItem(options.identifier));
  }
  if (keys.size === 0) return;
  await Promise.all(Array.from(keys).map((k) => cache.del(k))).catch(() => {
    // Best-effort cache invalidation
  });
}
