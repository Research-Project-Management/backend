/**
 * Centralized Redis key builders for the Pages / Manuscript domain.
 */
export const PAGES_CACHE_KEYS = {
  clsiCompile: (hash: string) => `flux:clsi:compile:${hash}`,
  lock: (resource: string) => `lock:manuscript:${resource}`,
  linkedFiles: (projectId: string) => `manuscript:linked_files:${projectId}`,
} as const;
