/**
 * Redis Key Namespaces for Document Page Module
 *
 * Standardized according to redis-core colon key conventions:
 * flux:doc:{entity}:{identifier}
 */

export const PAGE_REDIS_KEYS = {
  /**
   * Project document tree hierarchy (JSON array, TTL 1h)
   */
  projectTree: (projectId: string) => `flux:doc:tree:${projectId}`,

  /**
   * Page details and content by ID (JSON object, TTL 30m)
   */
  page: (pageId: string) => `flux:doc:page:${pageId}`,

  /**
   * Page version summaries list (JSON array, TTL 1h)
   */
  pageVersions: (pageId: string) => `flux:doc:versions:${pageId}`,

  /**
   * LaTeX rendered formula cache by SHA-256 hash (String/HTML, TTL 7d)
   */
  latex: (sha256: string) => `flux:doc:latex:${sha256}`,
} as const;

export const COLLABORATION_REDIS_KEYS = {
  /**
   * Presence hash per document room (Redis Hash, field: userId, TTL: sliding 60s)
   */
  presence: (pageId: string) => `flux:collab:presence:${pageId}`,

  /**
   * Yjs binary snapshot L2 cache (base64 string, TTL: 7d)
   */
  snapshot: (pageId: string) => `flux:collab:snapshot:${pageId}`,

  /**
   * Yjs keystroke-level op log (Redis Sorted Set, score=timestamp ms, TTL: 7d).
   * Enables Overleaf-style "time machine" history scrubbing without schema migrations.
   * Max 2000 entries per doc — compaction via BullMQ cron offloads old ops to PageVersion.
   */
  oplog: (pageId: string) => `flux:collab:oplog:${pageId}`,
} as const;

export const DOCUMENT_REDIS_KEYS = {
  ...PAGE_REDIS_KEYS,
  ...COLLABORATION_REDIS_KEYS,
};
