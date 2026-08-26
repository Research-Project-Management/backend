/**
 * Redis Key Namespaces for Storage Module
 *
 * Standardized according to redis-core colon key conventions:
 * flux:storage:{entity}:{identifier}
 */

export const STORAGE_REDIS_KEYS = {
  /**
   * Workspace folder files and subfolders by parent (JSON array, TTL 1h)
   */
  folderTree: (workspaceId: string, parentId?: string | null) =>
    `flux:storage:tree:${workspaceId}:${parentId || 'root'}`,

  /**
   * Total storage usage in bytes for workspace (Number, TTL 30m)
   */
  quota: (workspaceId: string) => `flux:storage:quota:${workspaceId}`,

  /**
   * File metadata by ID (JSON object, TTL 30m)
   */
  file: (fileId: string) => `flux:storage:file:${fileId}`,

  /**
   * Workspace labels list (JSON array, TTL 1h)
   */
  labels: (workspaceId: string) => `flux:storage:labels:${workspaceId}`,
} as const;
