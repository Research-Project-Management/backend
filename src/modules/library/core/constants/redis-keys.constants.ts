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

  // Saved Searches
  savedSearches: (scopeId: string) => `library:${scopeId}:saved-searches`,
  savedSearchesPattern: (scopeId: string) =>
    `library:${scopeId}:saved-searches*`,

  // Item Types (Static system registry)
  itemTypes: (includeSpecial: boolean) =>
    `library:system:item-types:${includeSpecial ? 'all' : 'bibliographic'}`,

  // Items Cache (Cache-Aside Pattern)
  item: (itemId: string) => `library:item:${itemId}`,
  itemDetails: (itemId: string) => `library:item:${itemId}:details`,
  itemFulltext: (itemId: string) => `library:item:${itemId}:fulltext`,
  itemAttachments: (itemId: string) => `library:item:${itemId}:attachments`,
  itemNotes: (itemId: string) => `library:item:${itemId}:notes`,
  itemUserOverlay: (itemId: string, userId: string) =>
    `library:item:${itemId}:u:${userId}`,
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

  // Search & Facets Cache
  searchItems: (scopeKey: string, version: string, filterHash: string) =>
    `library:search:items:${scopeKey}:v${version}:${filterHash}`,
  searchFacets: (scopeKey: string, version: string, filterHash: string) =>
    `library:search:facets:${scopeKey}:v${version}:${filterHash}`,
  searchFacetsPattern: (scopeId: string) =>
    `library:search:facets:*${scopeId}*`,
  searchItemsPattern: (scopeId: string) => `library:search:items:*${scopeId}*`,
  searchVersion: (scopeKey: string) => `library:search:version:${scopeKey}`,

  // Citation & CSL Styles Cache
  doiNegotiation: (format: string, doi: string) =>
    format === 'meta'
      ? `library:doi-cn:meta:${doi}`
      : `library:doi-cn:cite:${format}:${doi}`,
  cslStyleXml: (styleName: string, scopeId?: string) =>
    scopeId ? `csl:xml:${scopeId}:${styleName}` : `csl:xml:${styleName}`,
  cslCustomStylesList: (scopeId?: string) =>
    scopeId ? `csl:${scopeId}:custom-styles-list` : 'csl:custom-styles-list',
  cslStylesCatalogIndex: () => 'csl:catalog:styles-index',
};
