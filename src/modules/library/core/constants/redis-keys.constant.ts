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
};
