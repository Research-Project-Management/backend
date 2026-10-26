/**
 * Redis Key Namespaces for Library Module (redis-core convention)
 * Colon-separated hierarchical structure with user/project scope isolation.
 */
export const LIBRARY_REDIS_KEYS = {
  // Collections
  collections: (projectId: string) => `library:${projectId}:collections`,
  collectionTree: (projectId: string) =>
    `library:${projectId}:collections:tree`,
  collectionsPattern: (projectId: string) =>
    `library:${projectId}:collections*`,

  // Tags
  tags: (projectId: string) => `library:${projectId}:tags`,
  tagsPattern: (projectId: string) => `library:${projectId}:tags*`,

  // Item Types (Static system registry)
  itemTypes: (includeSpecial: boolean) =>
    `library:system:item-types:${includeSpecial ? 'all' : 'bibliographic'}`,

  // Items Cache (Cache-Aside Pattern)
  item: (itemId: string) => `library:item:${itemId}`,
  itemDetails: (itemId: string) => `library:item:${itemId}:details`,
  itemFulltext: (itemId: string) => `library:item:${itemId}:fulltext`,
  itemsList: (scopeKey: string, optionsHash: string) =>
    `library:${scopeKey}:items:list:${optionsHash}`,
  itemsPattern: (scopeKey: string) => `library:${scopeKey}:items*`,
  itemPattern: (itemId: string) => `library:item:${itemId}*`,
  counts: (userId: string, projectId?: string | null) =>
    projectId
      ? `library:counts:proj:${projectId}:u:${userId}`
      : userId.startsWith('proj:') || userId.startsWith('user:')
        ? `library:counts:${userId}`
        : `library:counts:user:${userId}`,
  countsPattern: (scopeId: string) => `library:counts:*${scopeId}*`,
  countsByScope: (scopeId: string) => `library:counts:*${scopeId}*`,

  // Search & Facets Cache
  searchFacetsPattern: (scopeId: string) =>
    `library:search:facets:*${scopeId}*`,
  searchItemsPattern: (scopeId: string) => `library:search:items:*${scopeId}*`,
  searchVersion: (scopeKey: string) => `library:search:version:${scopeKey}`,
};
