/**
 * Redis Key Namespaces for Library Module (redis-core convention)
 * Colon-separated hierarchical structure with workspace tenancy isolation.
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
};
