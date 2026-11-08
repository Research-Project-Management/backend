import { LIBRARY_REDIS_KEYS } from '../config/library.config';
import { IItemCacheInvalidator } from '../ports/catalog.port';
import { normalizeProjectScopeId } from '../domain/specification.domain';

export interface IRawLibraryCache {
  del(key: string): Promise<unknown>;
  delPattern?(pattern: string): Promise<unknown>;
  incr?(key: string): Promise<number>;
  get?<T>(key: string): Promise<T | null>;
}

export interface StandardLibraryCacheInvalidationParams {
  userId?: string;
  projectId?: string | null;
  itemIds?: string[];
  additionalProjectIds?: Array<string | null | undefined>;
  extraKeys?: string[];
  skipScopeInvalidation?: boolean;
  onlyUserStateOverlay?: boolean;
  preserveContentCaches?: boolean;
}

export type CacheInvalidatorOrGateway =
  | IItemCacheInvalidator
  | {
      invalidateForWrite?: (params: {
        userId: string;
        projectId?: string | null;
        itemIds?: string[];
        additionalProjectIds?: Array<string | null | undefined>;
        skipScopeInvalidation?: boolean;
        onlyUserStateOverlay?: boolean;
        preserveContentCaches?: boolean;
      }) => Promise<void>;
    }
  | null
  | undefined;

/**
 * Evicts raw Redis keys and patterns for a set of item IDs and user/project scopes.
 */
export async function invalidateLibraryScopeCaches(
  rawCache: IRawLibraryCache | null | undefined,
  params: StandardLibraryCacheInvalidationParams,
): Promise<void> {
  if (!rawCache) return;
  const {
    userId,
    projectId,
    itemIds,
    additionalProjectIds,
    skipScopeInvalidation,
    onlyUserStateOverlay,
    preserveContentCaches,
  } = params;
  const uniqueIds = itemIds
    ? Array.from(new Set(itemIds.filter(Boolean).map(String)))
    : [];
  const hasDelPattern = typeof rawCache.delPattern === 'function';
  const tasks: Promise<unknown>[] = [];

  for (const id of uniqueIds) {
    if (onlyUserStateOverlay) {
      tasks.push(
        rawCache.del(LIBRARY_REDIS_KEYS.item(id)),
        rawCache.del(LIBRARY_REDIS_KEYS.itemDetails(id)),
      );
      if (userId) {
        tasks.push(
          rawCache.del(LIBRARY_REDIS_KEYS.itemUserOverlay(id, userId)),
          rawCache.del(LIBRARY_REDIS_KEYS.counts(userId)),
          ...(projectId
            ? [rawCache.del(LIBRARY_REDIS_KEYS.counts(userId, projectId))]
            : []),
        );
      }
    } else if (preserveContentCaches) {
      tasks.push(
        rawCache.del(LIBRARY_REDIS_KEYS.item(id)),
        rawCache.del(LIBRARY_REDIS_KEYS.itemDetails(id)),
        rawCache.del(LIBRARY_REDIS_KEYS.itemAttachments(id)),
        rawCache.del(LIBRARY_REDIS_KEYS.itemNotes(id)),
      );
      if (userId) {
        tasks.push(rawCache.del(LIBRARY_REDIS_KEYS.itemUserOverlay(id, userId)));
      }
    } else {
      tasks.push(
        rawCache.del(LIBRARY_REDIS_KEYS.item(id)),
        rawCache.del(LIBRARY_REDIS_KEYS.itemDetails(id)),
        rawCache.del(LIBRARY_REDIS_KEYS.itemFulltext(id)),
        rawCache.del(LIBRARY_REDIS_KEYS.itemAttachments(id)),
        rawCache.del(LIBRARY_REDIS_KEYS.itemNotes(id)),
      );
      if (userId) {
        tasks.push(rawCache.del(LIBRARY_REDIS_KEYS.itemUserOverlay(id, userId)));
      }
      if (hasDelPattern) {
        tasks.push(rawCache.delPattern!(LIBRARY_REDIS_KEYS.itemPattern(id)));
      }
    }
  }

  if (!skipScopeInvalidation) {
    if (userId) {
      const userSyncScope = `user:${userId}`;
      const userScopeKey = `u:${userId}`;
      tasks.push(
        rawCache.del(LIBRARY_REDIS_KEYS.savedSearches(userId)),
        rawCache.del(LIBRARY_REDIS_KEYS.searchVersion(userId)),
        rawCache.del(LIBRARY_REDIS_KEYS.counts(userId)),
        rawCache.del(LIBRARY_REDIS_KEYS.tags(userId)),
        rawCache.del(LIBRARY_REDIS_KEYS.syncSequence(userSyncScope)),
        rawCache.del(LIBRARY_REDIS_KEYS.minRetainedSequence(userSyncScope)),
      );
      if (typeof rawCache.incr === 'function') {
        // Atomic O(1) version invalidation: invalidates collections, tree, tags, and itemsList without scanning keyspace
        tasks.push(
          rawCache.incr(LIBRARY_REDIS_KEYS.scopeVersion(userId)),
          rawCache.incr(LIBRARY_REDIS_KEYS.scopeVersion(userScopeKey)),
        );
      } else if (hasDelPattern) {
        tasks.push(
          rawCache.delPattern!(LIBRARY_REDIS_KEYS.tagsPattern(userId)),
          rawCache.delPattern!(LIBRARY_REDIS_KEYS.collectionsPattern(userId)),
          rawCache.delPattern!(
            LIBRARY_REDIS_KEYS.collectionsPattern(userScopeKey),
          ),
        );
      }
      if (hasDelPattern) {
        tasks.push(
          rawCache.delPattern!(LIBRARY_REDIS_KEYS.itemsPattern(userId)),
          rawCache.delPattern!(LIBRARY_REDIS_KEYS.countsPattern(userId)),
          rawCache.delPattern!(LIBRARY_REDIS_KEYS.searchFacetsPattern(userId)),
          rawCache.delPattern!(LIBRARY_REDIS_KEYS.searchItemsPattern(userId)),
        );
      }
    }

    const projectScopes = new Set<string>();
    const validBaseProject = normalizeProjectScopeId(projectId ?? undefined);
    if (validBaseProject) projectScopes.add(validBaseProject);
    if (additionalProjectIds) {
      for (const pid of additionalProjectIds) {
        const norm = normalizeProjectScopeId(pid ?? undefined);
        if (norm) projectScopes.add(norm);
      }
    }

    for (const validProjectId of projectScopes) {
      const projScope = `proj:${validProjectId}`;
      tasks.push(
        rawCache.del(LIBRARY_REDIS_KEYS.savedSearches(validProjectId)),
        rawCache.del(LIBRARY_REDIS_KEYS.searchVersion(validProjectId)),
        rawCache.del(LIBRARY_REDIS_KEYS.searchVersion(projScope)),
        rawCache.del(LIBRARY_REDIS_KEYS.counts(projScope)),
        ...(userId
          ? [rawCache.del(LIBRARY_REDIS_KEYS.counts(userId, validProjectId))]
          : []),
        rawCache.del(LIBRARY_REDIS_KEYS.tags(validProjectId)),
        rawCache.del(LIBRARY_REDIS_KEYS.tags(projScope)),
        rawCache.del(LIBRARY_REDIS_KEYS.syncSequence(projScope)),
        rawCache.del(LIBRARY_REDIS_KEYS.minRetainedSequence(projScope)),
      );
      if (typeof rawCache.incr === 'function') {
        // Atomic O(1) version invalidation for project scope
        tasks.push(
          rawCache.incr(LIBRARY_REDIS_KEYS.scopeVersion(validProjectId)),
          rawCache.incr(LIBRARY_REDIS_KEYS.scopeVersion(projScope)),
        );
      } else if (hasDelPattern) {
        tasks.push(
          rawCache.delPattern!(LIBRARY_REDIS_KEYS.tagsPattern(validProjectId)),
          rawCache.delPattern!(LIBRARY_REDIS_KEYS.tagsPattern(projScope)),
          rawCache.delPattern!(
            LIBRARY_REDIS_KEYS.collectionsPattern(validProjectId),
          ),
          rawCache.delPattern!(LIBRARY_REDIS_KEYS.collectionsPattern(projScope)),
        );
      }
      if (hasDelPattern) {
        tasks.push(
          rawCache.delPattern!(LIBRARY_REDIS_KEYS.itemsPattern(validProjectId)),
          rawCache.delPattern!(LIBRARY_REDIS_KEYS.itemsPattern(projScope)),
          rawCache.delPattern!(
            LIBRARY_REDIS_KEYS.countsPattern(validProjectId),
          ),
          rawCache.delPattern!(
            LIBRARY_REDIS_KEYS.searchFacetsPattern(validProjectId),
          ),
          rawCache.delPattern!(
            LIBRARY_REDIS_KEYS.searchItemsPattern(validProjectId),
          ),
        );
      }
    }
  }

  await Promise.all(tasks);
}

/**
 * Hollywood Principle delegation helper for Library write-path cache invalidation.
 */
export async function executeStandardLibraryCacheInvalidation(
  coordinatorOrGateway: CacheInvalidatorOrGateway,
  rawCache: IRawLibraryCache | null | undefined,
  params: StandardLibraryCacheInvalidationParams,
  onWarning?: (message: string) => void,
): Promise<void> {
  const { userId, projectId, itemIds, additionalProjectIds, extraKeys } =
    params;
  const uniqueIds = itemIds
    ? Array.from(new Set(itemIds.filter(Boolean).map(String)))
    : [];

  if (extraKeys && extraKeys.length > 0 && rawCache) {
    try {
      await Promise.all(extraKeys.map((k) => rawCache.del(k)));
    } catch (err: unknown) {
      if (onWarning) {
        onWarning(err instanceof Error ? err.message : String(err));
      }
    }
  }

  if (
    coordinatorOrGateway?.invalidateForWrite &&
    userId &&
    !params.skipScopeInvalidation &&
    !params.onlyUserStateOverlay &&
    !params.preserveContentCaches
  ) {
    try {
      await coordinatorOrGateway.invalidateForWrite({
        userId: String(userId),
        projectId: projectId ? String(projectId) : undefined,
        itemIds: uniqueIds.length > 0 ? uniqueIds : undefined,
        additionalProjectIds,
      });
      return;
    } catch (err: unknown) {
      if (onWarning) {
        onWarning(err instanceof Error ? err.message : String(err));
      }
      return;
    }
  }

  if (rawCache) {
    try {
      await invalidateLibraryScopeCaches(rawCache, {
        ...params,
        itemIds: uniqueIds,
      });
      return;
    } catch (err: unknown) {
      if (onWarning) {
        onWarning(err instanceof Error ? err.message : String(err));
      }
      return;
    }
  }

  if (coordinatorOrGateway?.invalidateForWrite && userId) {
    try {
      await coordinatorOrGateway.invalidateForWrite({
        userId: String(userId),
        projectId: projectId ? String(projectId) : undefined,
        itemIds: uniqueIds.length > 0 ? uniqueIds : undefined,
        additionalProjectIds,
        skipScopeInvalidation: params.skipScopeInvalidation,
        onlyUserStateOverlay: params.onlyUserStateOverlay,
        preserveContentCaches: params.preserveContentCaches,
      });
    } catch (err: unknown) {
      if (onWarning) {
        onWarning(err instanceof Error ? err.message : String(err));
      }
    }
  }
}
