/**
 * Redis Key Namespaces for Document Module
 *
 * Standardized according to redis-core colon key conventions:
 * flux:doc:{entity}:{identifier}
 */

export const DOCUMENT_REDIS_KEYS = {
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
