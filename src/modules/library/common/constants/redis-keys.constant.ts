/**
 * Redis Key Namespaces for Library Module (redis-core convention)
 * Colon-separated hierarchical structure with workspace tenancy isolation.
 */
export const LIBRARY_REDIS_KEYS = {
  // Collections
  collections: (workspaceId: string) => `library:${workspaceId}:collections`,
  collectionTree: (workspaceId: string) => `library:${workspaceId}:collections:tree`,
  collectionsPattern: (workspaceId: string) => `library:${workspaceId}:collections*`,

  // Tags
  tags: (workspaceId: string) => `library:${workspaceId}:tags`,
  tagsPattern: (workspaceId: string) => `library:${workspaceId}:tags*`,

  // Item Types (Static system registry)
  itemTypes: (includeSpecial: boolean) =>
    `library:system:item-types:${includeSpecial ? 'all' : 'bibliographic'}`,
};
