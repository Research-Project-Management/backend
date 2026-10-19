import { Injectable, Logger, Optional } from '@nestjs/common';
import { QueryRepository } from '@/modules/library/catalog/repositories/query.repository';
import { RedisCacheService } from '@/core';
import { normalizeProjectScopeId } from '@/modules/library/core';
import { LIBRARY_REDIS_KEYS } from '@/modules/library/core/constants/redis-keys.constants';
import { ItemsMapper } from '@/modules/library/catalog/domain/items.mapper';
import { CursorPaginatedResult } from '@/modules/library/catalog/dto/items.dto';
import {
  QualityAuditCandidateItem,
  DuplicateCandidateItem,
  ItemDetail,
} from '@/modules/library/core/types/bibliographic.types';
import { AccessService, Permission } from '@/modules/project/access';

export interface LibraryPermissionsContract {
  canRead: boolean;
  canCreateItem: boolean;
  canEditItem: boolean;
  canDeleteItem: boolean;
  canPurgeItem: boolean;
  canManageCollections: boolean;
  canImport: boolean;
  canExport: boolean;
  canAnnotate: boolean;
}

export interface LibraryScopeAccessContract {
  scope: 'personal' | 'project';
  role: 'owner' | 'coordinator' | 'contributor' | 'reviewer';
  permissions: LibraryPermissionsContract;
}

const PERSONAL_LIBRARY_PERMISSIONS: LibraryPermissionsContract = {
  canRead: true,
  canCreateItem: true,
  canEditItem: true,
  canDeleteItem: true,
  canPurgeItem: true,
  canManageCollections: true,
  canImport: true,
  canExport: true,
  canAnnotate: true,
};

/**
 * ItemQueryService — Dedicated Domain Service for Item Information Retrieval.
 */
@Injectable()
export class ItemQueryService {
  private readonly logger = new Logger(ItemQueryService.name);

  constructor(
    private readonly query: QueryRepository,
    @Optional() private readonly cache?: RedisCacheService,
    @Optional() private readonly accessService?: AccessService,
  ) {}

  private mapFlattenedState<T extends Record<string, unknown>>(
    item: T,
    userId?: string,
  ):
    | (T & { readStatus: string; rating: number; lastReadAt: string | null })
    | null {
    return ItemsMapper.mapFlattenedState(item, userId);
  }

  /**
   * Computes authoritative Library permissions and role for a given user and scope (Personal or Project).
   * Respects both role baseline and per-member permissionOverrides when AccessService is present.
   */
  async getPermissions(
    userId: string,
    projectId?: string,
    accessHint?: {
      role?: string;
      permissionOverrides?: Record<string, boolean> | null;
      effectivePermissions?: readonly string[];
    },
  ): Promise<LibraryScopeAccessContract> {
    const validProjectId = normalizeProjectScopeId(projectId);

    if (!validProjectId) {
      return {
        scope: 'personal',
        role: 'owner',
        permissions: { ...PERSONAL_LIBRARY_PERMISSIONS },
      };
    }
    projectId = validProjectId;

    let resolvedRole: string | null = accessHint?.role ?? null;
    let overrides: Record<string, boolean> | null | undefined =
      accessHint?.permissionOverrides;
    let effectivePerms: readonly string[] | undefined =
      accessHint?.effectivePermissions;

    if (!resolvedRole && this.accessService?.getMemberAccessContext) {
      try {
        const ctx = await this.accessService.getMemberAccessContext(
          projectId,
          userId,
        );
        if (ctx) {
          resolvedRole = ctx.role;
          overrides = ctx.permissionOverrides;
          effectivePerms = ctx.effectivePermissions;
        }
      } catch {
        // Fallback to repository lookup
      }
    }

    if (!resolvedRole) {
      try {
        resolvedRole = await this.query.getProjectMemberRole(userId, projectId);
      } catch {
        resolvedRole = null;
      }
    }

    const normalizedRole = (
      resolvedRole ? String(resolvedRole).toLowerCase() : 'reviewer'
    ) as 'owner' | 'coordinator' | 'contributor' | 'reviewer';

    const hasPerm = (perm: Permission, roleDefault: boolean): boolean => {
      if (normalizedRole === 'owner') return true;
      if (overrides && typeof overrides[perm] === 'boolean') {
        return overrides[perm];
      }
      if (Array.isArray(effectivePerms)) {
        return effectivePerms.includes(perm);
      }
      if (this.accessService?.hasPermission) {
        return this.accessService.hasPermission(
          normalizedRole,
          perm,
          overrides,
        );
      }
      return roleDefault;
    };

    const isWriteRole =
      normalizedRole === 'owner' ||
      normalizedRole === 'coordinator' ||
      normalizedRole === 'contributor';
    const isOwnerRole = normalizedRole === 'owner';

    const canRead = hasPerm(Permission.LIBRARY_READ, true);
    const canUpload = hasPerm(Permission.LIBRARY_UPLOAD, isWriteRole);
    const canUpdate = hasPerm(Permission.LIBRARY_UPDATE, isWriteRole);
    const canPurge = hasPerm(Permission.LIBRARY_DELETE, isOwnerRole);
    const canExport = hasPerm(Permission.LIBRARY_EXPORT, true);
    const canAnnotate = hasPerm(Permission.LIBRARY_ANNOTATE, true);

    return {
      scope: 'project',
      role: normalizedRole,
      permissions: {
        canRead,
        canCreateItem: canUpload,
        canEditItem: canUpdate,
        canDeleteItem: canUpdate,
        canPurgeItem: canPurge,
        canManageCollections: canUpdate,
        canImport: canUpload,
        canExport,
        canAnnotate,
      },
    };
  }

  /**
   * Retrieves high-performance aggregated system counts (unfiled, starred, trash, total, itemTypes)
   * and authoritative scope permissions for fast sidebar rendering without downloading item arrays.
   */
  async getCounts(
    userId: string,
    projectId?: string,
    accessHint?: {
      role?: string;
      permissionOverrides?: Record<string, boolean> | null;
      effectivePermissions?: readonly string[];
    },
  ): Promise<{
    total: number;
    unfiled: number;
    starred: number;
    trash: number;
    itemTypes: Record<string, number>;
    role: 'owner' | 'coordinator' | 'contributor' | 'reviewer';
    permissions: LibraryPermissionsContract;
  }> {
    const cacheKey = projectId
      ? `library:counts:proj:${projectId}`
      : `library:counts:user:${userId}`;

    const fetchCountsData = async () => {
      const [total, unfiled, starred, trash, itemTypes] = await Promise.all([
        this.query.count(userId, { view: 'all', projectId }),
        this.query.count(userId, { view: 'unfiled', projectId }),
        this.query.count(userId, { view: 'starred', projectId }),
        this.query.count(userId, { view: 'trash', projectId }),
        this.query.countByItemType(userId, projectId),
      ]);
      return {
        total,
        unfiled,
        starred,
        trash,
        itemTypes: itemTypes || {},
      };
    };

    const [countsData, accessContract] = await Promise.all([
      this.cache
        ? this.cache.wrap(cacheKey, fetchCountsData, 15)
        : fetchCountsData(),
      this.getPermissions(userId, projectId, accessHint),
    ]);

    return {
      ...countsData,
      itemTypes: countsData.itemTypes || {},
      role: accessContract.role,
      permissions: accessContract.permissions,
    };
  }

  async getItem(userId: string, id: string, projectId?: string) {
    const validProjectId = normalizeProjectScopeId(projectId);
    const cacheKey = LIBRARY_REDIS_KEYS.item(id);
    const fetchRaw = () => this.query.findById(userId, id, validProjectId);

    let item: ItemDetail | Record<string, unknown> | null = null;

    if (this.cache) {
      try {
        const cached = await this.cache.get<
          ItemDetail | Record<string, unknown>
        >(cacheKey);
        if (cached) {
          const isOwner = cached.userId === userId;
          const isProjectMatch =
            validProjectId && cached.projectId === validProjectId;
          if (isOwner || isProjectMatch) {
            if (
              Array.isArray((cached as Record<string, unknown>).states) ||
              (cached as Record<string, unknown>).readStatus !== undefined
            ) {
              return this.mapFlattenedState(cached, userId);
            }
            return cached;
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.debug(`Cache lookup error for ${cacheKey}: ${msg}`);
      }

      item = await fetchRaw();
      if (item) {
        await this.cache.set(cacheKey, item, 300).catch(() => undefined);
      }
    } else {
      item = await fetchRaw();
    }

    if (!item) return null;

    const isAuthorized = validProjectId
      ? item.projectId === validProjectId
      : item.userId === userId && !item.projectId;
    if (!isAuthorized) {
      return null;
    }

    return this.mapFlattenedState(item, userId);
  }

  async listItems(
    userId: string,
    options: {
      view?:
        | 'all'
        | 'recent'
        | 'unfiled'
        | 'trash'
        | 'my-publications'
        | 'publications'
        | 'starred'
        | 'retracted';
      collectionId?: string;
      collectionIds?: string[];
      includeSubcollections?: boolean;
      recursive?: boolean;
      tagId?: string;
      tag?: string;
      search?: string;
      limit?: number;
      cursor?: string;
      page?: number;
      orderBy?: string;
      orderDirection?: 'asc' | 'desc';
      itemType?: string;
      type?: string;
      fromYear?: number;
      toYear?: number;
      readStatus?: string;
      hasFile?: boolean;
      hasNotes?: boolean;
      projectId?: string;
      include?: string;
      isRetracted?: boolean;
      onlyFlagged?: boolean;
    },
  ): Promise<CursorPaginatedResult<ItemDetail | Record<string, unknown>>> {
    const limit = Math.min(options.limit ?? 50, 100);
    const validProjectId = normalizeProjectScopeId(options.projectId);
    const scopeKey = validProjectId ? `proj:${validProjectId}` : userId;
    const canCache = !options.search && !options.cursor;
    const extraCacheParts = [
      options.page !== undefined && options.page > 1 ? `p=${options.page}` : '',
      options.orderBy ? `ob=${options.orderBy}` : '',
      options.orderDirection ? `od=${options.orderDirection}` : '',
      options.itemType || options.type
        ? `it=${options.itemType || options.type}`
        : '',
      options.fromYear !== undefined ? `fy=${options.fromYear}` : '',
      options.toYear !== undefined ? `ty=${options.toYear}` : '',
      options.readStatus ? `rs=${options.readStatus}` : '',
      options.hasFile !== undefined ? `hf=${options.hasFile}` : '',
      options.hasNotes !== undefined ? `hn=${options.hasNotes}` : '',
      options.tag ? `t=${options.tag}` : '',
      options.collectionIds?.length
        ? `cids=${options.collectionIds.join(',')}`
        : '',
      options.includeSubcollections !== undefined
        ? `sub=${options.includeSubcollections}`
        : '',
      options.recursive !== undefined ? `rec=${options.recursive}` : '',
    ]
      .filter(Boolean)
      .join(':');
    const baseCacheSuffix = `${options.view || 'all'}:${options.collectionId || ''}:${options.tagId || ''}:${limit}`;
    const cacheKey = canCache
      ? LIBRARY_REDIS_KEYS.itemsList(
          scopeKey,
          extraCacheParts
            ? `${baseCacheSuffix}:${extraCacheParts}`
            : baseCacheSuffix,
        )
      : null;

    if (canCache && cacheKey && this.cache) {
      try {
        const cached =
          await this.cache.get<
            CursorPaginatedResult<ItemDetail | Record<string, unknown>>
          >(cacheKey);
        if (cached) {
          return cached;
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.debug(`Cache lookup error for ${cacheKey}: ${message}`);
      }
    }

    const queryOptions = { ...options, userId };
    const isInitialPage = !options.cursor;
    const shouldCount = isInitialPage;
    const [totalCount, rawItems] = await Promise.all([
      shouldCount
        ? this.query.count(userId, queryOptions)
        : Promise.resolve(undefined),
      this.query.findMany(userId, {
        ...queryOptions,
        limit,
      }),
    ]);

    let hasNextPage = false;
    let nextCursor: string | undefined;

    if (rawItems.length > limit) {
      hasNextPage = true;
      rawItems.pop();
      nextCursor = rawItems[rawItems.length - 1]?.id;
    }

    const items = rawItems
      .slice(0, limit)
      .map((it) => this.mapFlattenedState(it, userId))
      .filter((it): it is NonNullable<typeof it> => it !== null);

    const result: CursorPaginatedResult<ItemDetail | Record<string, unknown>> =
      {
        items,
        meta: {
          cursor: nextCursor,
          hasNextPage,
          totalCount,
        },
      };

    if (canCache && cacheKey && this.cache) {
      try {
        await this.cache.set(cacheKey, result, 60);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.debug(`Cache set error for ${cacheKey}: ${message}`);
      }
    }

    return result;
  }

  async getItemSnapshot(userId: string, itemId: string) {
    return this.query.getItemSnapshot(userId, itemId);
  }

  async getItemSnapshots(userId: string, itemIds: string[]) {
    return this.query.getItemSnapshots(userId, itemIds);
  }

  // IItemExistencePort Implementation

  async exists(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<boolean> {
    return this.query.exists(userId, itemId, undefined, projectId);
  }

  async assertExists(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<void> {
    return this.query.assertExists(userId, itemId, undefined, projectId);
  }

  async existMany(
    userId: string,
    itemIds: string[],
    projectId?: string,
  ): Promise<Map<string, boolean>> {
    return this.query.existMany(userId, itemIds, undefined, projectId);
  }

  async validateItemsBelongToUser(
    userId: string,
    itemIds: string[],
    projectId?: string,
  ): Promise<{ valid: boolean; missingIds: string[] }> {
    const existMap = await this.existMany(userId, itemIds, projectId);
    const missingIds: string[] = [];
    for (const id of itemIds) {
      if (!existMap.get(id)) {
        missingIds.push(id);
      }
    }
    return {
      valid: missingIds.length === 0,
      missingIds,
    };
  }

  // IItemReadPort Implementation

  async findById(userId: string, itemId: string, projectId?: string) {
    return this.query.findById(userId, itemId, projectId);
  }

  async findByIds(userId: string, itemIds: string[], projectId?: string) {
    return this.query.findByIds(userId, itemIds, projectId);
  }

  async findByDoi(userId: string, doi: string, projectId?: string) {
    return this.query.findByDoi(userId, doi, projectId);
  }

  async findSummaryById(userId: string, itemId: string, projectId?: string) {
    return this.query.findSummaryById(userId, itemId, undefined, projectId);
  }

  async findSummariesByIds(
    userId: string,
    itemIds: string[],
    projectId?: string,
  ) {
    return projectId !== undefined
      ? this.query.findSummariesByIds(userId, itemIds, projectId)
      : this.query.findSummariesByIds(userId, itemIds);
  }

  async findQualityAuditItems(
    userId?: string,
    limit?: number,
    projectId?: string,
  ): Promise<QualityAuditCandidateItem[]> {
    return (await this.query.findQualityAuditItems(
      userId,
      limit,
      projectId,
    )) as unknown as QualityAuditCandidateItem[];
  }

  async findDuplicateCandidateItems(
    userId?: string,
    limit?: number,
    projectId?: string,
  ): Promise<DuplicateCandidateItem[]> {
    return (await this.query.findDuplicateCandidateItems(
      userId,
      limit,
      projectId,
    )) as unknown as DuplicateCandidateItem[];
  }

  async count(
    userId: string,
    options?: Record<string, unknown>,
  ): Promise<number> {
    return this.query.count(userId, options || { view: 'all' });
  }

  async findMany(
    userId: string,
    options?: Record<string, unknown>,
  ): Promise<ItemDetail[]> {
    return await this.query.findMany(userId, options || {});
  }

  async findMatchCandidates(
    scope: { userId?: string; projectId?: string | null },
    criteria: {
      doi?: string | null;
      arxivId?: string | null;
      pmid?: string | null;
      isbn?: string | null;
      titleWords?: string[];
      titlePrefix?: string;
    },
  ) {
    return this.query.findMatchCandidates(scope, criteria);
  }
}
