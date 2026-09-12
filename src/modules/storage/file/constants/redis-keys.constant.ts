/**
 * Redis Key Namespaces for Storage Module
 *
 * Standardized according to redis-core colon key conventions:
 * flux:storage:{entity}:{identifier}
 */

export const STORAGE_REDIS_KEYS = {
  /**
   * Folder files and subfolders by parent (JSON array, TTL 1h)
   */
  folderTree: (scopeId: string, parentId?: string | null) =>
    `flux:storage:tree:${scopeId}:${parentId || 'root'}`,

  /**
   * Total storage usage in bytes for scope (Number, TTL 30m)
   */
  quota: (scopeId: string) => `flux:storage:quota:${scopeId}`,

  /**
   * File metadata by ID (JSON object, TTL 30m)
   */
  file: (fileId: string) => `flux:storage:file:${fileId}`,

  /**
   * Scope labels list (JSON array, TTL 1h)
   */
  labels: (scopeId: string) => `flux:storage:labels:${scopeId}`,
} as const;
