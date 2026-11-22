import { Injectable, Inject, Optional } from '@nestjs/common';
import { createHash } from 'crypto';
import { RedisCacheService } from '@/core';
import {
  normalizeProjectSpaceId,
  libraryConfig,
  LIBRARY_REDIS_KEYS,
  UNIT_OF_WORK,
  IUnitOfWork,
  SingleFlightCoalescer,
} from '@/modules/library/core';
import { QueryRepository } from '@/modules/library/catalog/repositories/query.repository';
import { SavedSearchesService } from './saved-searches.service';
import { ItemQueryService } from '@/modules/library/catalog/services/item-query.service';
import { CollectionsService } from '@/modules/library/catalog/services/collections.service';
import { TagsService } from '@/modules/library/catalog/services/tags.service';
import { TypesService } from '@/modules/library/catalog/services/types.service';

interface LibraryBootstrapOptions {
  projectId?: string;
  includeItems?: boolean;
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
  searchMode?: 'title_creator_year' | 'fields_tags' | 'everything' | string;
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
  fields?: string;
  onlyFlagged?: boolean;
  isRetracted?: boolean;
}

/**
 * Workspace BFF Bootstrap Service for the Library Module.
 *
 * Aggregates initial workspace metadata (counts, permissions, collections,
 * savedSearches, tags, sync sequence, Zotero schema registry, feed subscriptions)
 * and optional initial items page in a single coalesced request with per-branch
 * fault isolation (avoiding both All-or-Nothing 500 crashes and fake `[]` cache poisoning).
 */
@Injectable()
export class LibraryBootstrapService {
  private readonly singleFlight = new SingleFlightCoalescer();
  private static readonly BRANCH_DEADLINE_MS = 3_500;

  private withBranchDeadline<T>(promise: Promise<T>): Promise<T | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(
        () => resolve(undefined),
        LibraryBootstrapService.BRANCH_DEADLINE_MS,
      );
      if (typeof timer === 'object' && 'unref' in timer) {
        timer.unref();
      }
    });
    return Promise.race([promise.catch(() => undefined), timeout]).finally(
      () => {
        if (timer) clearTimeout(timer);
      },
    );
  }

  constructor(
    private readonly queryRepo: QueryRepository,
    private readonly itemQueryService: ItemQueryService,
    private readonly collectionsService: CollectionsService,
    private readonly savedSearchesService: SavedSearchesService,
    private readonly typesService: TypesService,
    @Optional() @Inject(UNIT_OF_WORK) private readonly libraryTx?: IUnitOfWork,
    @Optional() private readonly tagsService?: TagsService,
    @Optional() private readonly cache?: RedisCacheService,
  ) {}

  private applyJitter(ttl: number): number {
    return libraryConfig().app.isTest
      ? ttl
      : Math.max(1, Math.floor(ttl * (0.9 + Math.random() * 0.2)));
  }

  private getFeedSubscriptionsCached(userId: string) {
    const cacheKey = LIBRARY_REDIS_KEYS.feedSubscriptions(userId);
    const loadFeeds = () => this.queryRepo.findUserFeedSubscriptions(userId);
    return this.singleFlight.execute(cacheKey, () =>
      this.cache
        ? this.cache.wrap(cacheKey, loadFeeds, this.applyJitter(300))
        : loadFeeds(),
    );
  }

  async getBootstrap(
    userId: string,
    options: LibraryBootstrapOptions = {},
    accessHint?: {
      role?: string;
      permissionOverrides?: Record<string, boolean> | null;
      effectivePermissions?: readonly string[];
    },
  ) {
    const validProjectId = normalizeProjectSpaceId(
      (options as { spaceId?: string }).spaceId ?? options.projectId,
      userId,
    );
    const shouldIncludeItems = options.includeItems !== false;
    const syncScope = validProjectId
      ? { projectId: validProjectId }
      : { userId };

    const optionsHash = createHash('sha256')
      .update(JSON.stringify(options || {}))
      .digest('hex')
      .slice(0, 16);

    const flightKey = [
      validProjectId ? `proj:${validProjectId}` : `user:${userId}`,
      userId,
      shouldIncludeItems ? 'items:1' : 'items:0',
      optionsHash,
    ].join(':');

    return this.singleFlight.execute(flightKey, async () => {
      const [
        counts,
        collectionsResult,
        savedSearches,
        tags,
        latestSeq,
        feedSubscriptions,
        itemsResult,
      ] = await Promise.all([
        this.withBranchDeadline(
          this.itemQueryService.getCounts(userId, validProjectId, accessHint),
        ),
        this.withBranchDeadline(
          this.collectionsService.getCollections(userId, validProjectId),
        ),
        this.withBranchDeadline(
          this.savedSearchesService.findAll(userId, validProjectId),
        ),
        this.tagsService?.getTags
          ? this.withBranchDeadline(
              this.tagsService.getTags(userId, { projectId: validProjectId }),
            )
          : Promise.resolve(undefined),
        this.libraryTx?.getLatestSequence
          ? this.withBranchDeadline(this.libraryTx.getLatestSequence(syncScope))
          : Promise.resolve(0n),
        validProjectId
          ? Promise.resolve([])
          : this.withBranchDeadline(this.getFeedSubscriptionsCached(userId)),
        shouldIncludeItems
          ? this.itemQueryService.listItems(userId, {
              ...options,
              projectId: validProjectId,
            })
          : Promise.resolve(undefined),
      ]);

      const degradedBranches: string[] = [];
      if (counts === undefined) degradedBranches.push('counts');
      if (collectionsResult?.collections === undefined)
        degradedBranches.push('collections');
      if (savedSearches === undefined) degradedBranches.push('savedSearches');
      if (this.tagsService?.getTags && tags === undefined)
        degradedBranches.push('tags');
      if (this.libraryTx?.getLatestSequence && latestSeq === undefined) {
        degradedBranches.push('syncVersion');
      }
      if (!validProjectId && feedSubscriptions === undefined) {
        degradedBranches.push('feedSubscriptions');
      }

      const snapshot = this.typesService.getSnapshot();
      const itemTypesList = this.typesService.getAllItemTypes();

      return {
        scope: validProjectId ? 'project' : 'user',
        spaceId: validProjectId ?? userId,
        projectId: validProjectId ?? null,
        ...(degradedBranches.length > 0
          ? { degraded: true, degradedBranches }
          : {}),
        ...(counts !== undefined ? { counts } : {}),
        ...(collectionsResult?.collections !== undefined
          ? { collections: collectionsResult.collections }
          : {}),
        ...(savedSearches !== undefined ? { savedSearches } : {}),
        ...(tags !== undefined ? { tags } : {}),
        ...(latestSeq !== undefined
          ? {
              syncVersion: {
                version: latestSeq.toString(),
                scope: validProjectId ? 'project' : 'user',
                spaceId: validProjectId ?? userId,
              },
            }
          : {}),
        itemTypes: {
          success: true,
          schemaVersion: snapshot.version,
          count: itemTypesList.length,
          itemTypes: itemTypesList,
          baseFieldMappings: snapshot.baseFieldMappings,
          creatorRoles: snapshot.creatorRoles,
          cslTypeMap: snapshot.cslTypeMap,
          cslFieldMap: snapshot.cslFieldMap,
        },
        ...(feedSubscriptions !== undefined ? { feedSubscriptions } : {}),
        ...(itemsResult
          ? {
              items: itemsResult.items,
              pagination: itemsResult.meta,
              meta: itemsResult.meta,
            }
          : {}),
      };
    });
  }
}
