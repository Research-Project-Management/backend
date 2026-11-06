import { Injectable, Inject, Optional, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { RedisCacheService } from '@/core';
import { normalizeProjectScopeId, libraryConfig, LIBRARY_REDIS_KEYS, UNIT_OF_WORK, IUnitOfWork, SingleFlightCoalescer, invalidateLibraryScopeCaches, LibraryItemSource, CATALOG_FACADE, ICatalogFacade, CatalogItemSummary, ItemsMapper } from '@/modules/library/core';
import { QueryRepository } from '@/modules/library/catalog/repositories/query.repository';
import { SavedSearchesService } from './saved-searches.service';
import { Prisma } from '@prisma/client';
import { ItemService } from '@/modules/library/catalog/services/items.service';
import { ItemQueryService } from '@/modules/library/catalog/services/item-query.service';
import { ItemCurationService } from '@/modules/library/catalog/services/item-curation.service';
import { CollectionsService } from '@/modules/library/catalog/services/collections.service';
import { TagsService } from '@/modules/library/catalog/services/tags.service';
import { TypesService, ItemCacheCoordinator } from '@/modules/library/catalog/services/schema-validator.service';
import { StateService } from '@/modules/library/catalog/services/state.service';
import { NotesService } from '@/modules/library/catalog/services/notes.service';
import { ItemDetail, DuplicateCandidateItem, QualityAuditCandidateItem, CreateItemData, UpdateItemData } from '@/modules/library/core/types/bibliographic.types';
import { NoteEntity, CreateNoteData } from '@/modules/library/catalog/types/catalog.types';
import { ItemFieldDefinition } from '@/modules/library/core/types/schema.types';

interface LibraryBootstrapOptions {
  projectId?: string; includeItems?: boolean;
  view?: 'all' | 'recent' | 'unfiled' | 'trash' | 'my-publications' | 'publications' | 'starred' | 'retracted';
  collectionId?: string; collectionIds?: string[]; includeSubcollections?: boolean; recursive?: boolean;
  tagId?: string; tag?: string; search?: string; searchMode?: 'title_creator_year' | 'fields_tags' | 'everything' | string;
  limit?: number; cursor?: string; page?: number; orderBy?: string; orderDirection?: 'asc' | 'desc';
  itemType?: string; type?: string; fromYear?: number; toYear?: number; readStatus?: string;
  hasFile?: boolean; hasNotes?: boolean; fields?: string; onlyFlagged?: boolean; isRetracted?: boolean;
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
      timer = setTimeout(() => resolve(undefined), LibraryBootstrapService.BRANCH_DEADLINE_MS);
      if (typeof timer === 'object' && 'unref' in timer) {
        timer.unref();
      }
    });
    return Promise.race([
      promise.catch(() => undefined),
      timeout,
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
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
    const validProjectId = normalizeProjectScopeId(options.projectId);
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
          : this.withBranchDeadline(
              this.getFeedSubscriptionsCached(userId),
            ),
        shouldIncludeItems
          ? this.itemQueryService.listItems(userId, {
              ...options,
              projectId: validProjectId,
            })
          : Promise.resolve(undefined),
      ]);

      const degradedBranches: string[] = [];
      if (counts === undefined) degradedBranches.push('counts');
      if (collectionsResult?.collections === undefined) degradedBranches.push('collections');
      if (savedSearches === undefined) degradedBranches.push('savedSearches');
      if (this.tagsService?.getTags && tags === undefined) degradedBranches.push('tags');
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
        scopeId: validProjectId ?? userId,
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
                scopeId: validProjectId ?? userId,
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

export { CATALOG_FACADE, ItemsMapper };
export type { ICatalogFacade, CatalogItemSummary };

/**
 * Public Facade for Catalog Bounded Context.
 * Directly communicates with clean, modular services.
 */
@Injectable()
export class CatalogFacade implements ICatalogFacade {
  constructor(
    private readonly queryService: ItemQueryService,
    private readonly itemService: ItemService,
    private readonly collectionsService: CollectionsService,
    private readonly tagsService: TagsService,
    private readonly typesService: TypesService,
    private readonly stateService: StateService,
    private readonly notesService: NotesService,
    @Optional()
    private readonly curationService?: ItemCurationService,
    @Optional()
    private readonly cacheCoordinator?: ItemCacheCoordinator,
  ) {}

  async getItem<T = ItemDetail>(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<T | null> {
    if (typeof this.queryService.getItem === 'function') {
      return (await this.queryService.getItem(userId, itemId, projectId)) as unknown as T | null;
    }
    const raw = await this.queryService.findById(userId, itemId, projectId);
    return raw ? (ItemsMapper.mapFlattenedState(raw, userId) as unknown as T) : null;
  }

  async getItemSummary<T = CatalogItemSummary>(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<T | null> {
    return (await this.queryService.findSummaryById(
      userId,
      itemId,
      projectId,
    )) as T | null;
  }

  async itemExists(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<boolean> {
    return this.queryService.exists(userId, itemId, projectId);
  }

  async getTags<T = unknown>(
    userId: string,
    options?: { includeInactive?: boolean; projectId?: string },
  ): Promise<T[]> {
    return (await this.tagsService.getTags(userId, options)) as unknown as T[];
  }

  async getItemState<T = unknown>(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<T | null> {
    return (await this.stateService.getState(
      userId,
      itemId,
      projectId,
    )) as unknown as T | null;
  }

  async createItem<T = ItemDetail, D = CreateItemData>(
    userId: string,
    data: D,
    options?: {
      expectedVersion?: number;
      suppressIndexing?: boolean;
      projectId?: string;
      source?: LibraryItemSource;
      idempotencyKey?: string;
      correlationId?: string;
    },
    projectId?: string,
  ): Promise<T> {
    return (await this.itemService.createItem(
      userId,
      data as CreateItemData,
      options,
      projectId,
    )) as unknown as T;
  }

  async updateItem<T = ItemDetail, D = UpdateItemData>(
    userId: string,
    itemId: string,
    data: D,
    options?: { expectedVersion?: number; projectId?: string },
  ): Promise<T> {
    return (await this.itemService.updateItem(
      userId,
      itemId,
      options?.expectedVersion,
      data as UpdateItemData,
      undefined,
      options?.projectId,
    )) as unknown as T;
  }

  async deleteItem(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<void> {
    await this.itemService.deleteItem(
      userId,
      itemId,
      undefined,
      undefined,
      projectId,
    );
  }

  async findByIds<T = ItemDetail>(
    userId: string,
    itemIds: string[],
    projectId?: string,
    options?: { includeContent?: boolean },
  ): Promise<T[]> {
    const raw =
      options?.includeContent !== undefined
        ? await this.queryService.findByIds(userId, itemIds, projectId, options)
        : await this.queryService.findByIds(userId, itemIds, projectId);
    return ItemsMapper.toDomainList(raw, userId) as unknown as T[];
  }

  async countItems(
    userId: string,
    options?: Record<string, unknown>,
  ): Promise<number> {
    return this.queryService.count(userId, options || { view: 'all' });
  }

  async findMany<T = ItemDetail>(
    userId: string,
    options?: Record<string, unknown>,
  ): Promise<T[]> {
    return (await this.queryService.findMany(
      userId,
      options || {},
    )) as unknown as T[];
  }

  async validateItemType(type: string): Promise<boolean> {
    return this.typesService.isValidItemType(type);
  }

  getPrimaryCreatorType(itemType: string): string {
    return this.typesService.getPrimaryCreatorType(itemType);
  }

  getOrderedFields(itemType: string): ItemFieldDefinition[] {
    return this.typesService.getOrderedFields(itemType);
  }

  async findQualityAuditItems<T = QualityAuditCandidateItem>(
    userId: string,
    limit?: number,
    projectId?: string,
  ): Promise<T[]> {
    return (await this.queryService.findQualityAuditItems(
      userId,
      limit,
      projectId,
    )) as unknown as T[];
  }

  async findDuplicateCandidateItems<T = DuplicateCandidateItem>(
    userId: string,
    limit?: number,
    projectId?: string,
  ): Promise<T[]> {
    return (await this.queryService.findDuplicateCandidateItems(
      userId,
      limit,
      projectId,
    )) as unknown as T[];
  }

  async mergeItems(
    tx: Prisma.TransactionClient,
    duplicateItemIds: string[],
    primaryItemId: string,
  ): Promise<void> {
    await Promise.all([
      this.tagsService.mergeTagsToItem(tx, duplicateItemIds, primaryItemId),
      this.collectionsService.transferItemMemberships(
        duplicateItemIds,
        primaryItemId,
        tx,
      ),
      this.stateService.transferUserItemStates(
        tx,
        duplicateItemIds,
        primaryItemId,
      ),
      this.notesService
        ? this.notesService.reassignToItem(duplicateItemIds, primaryItemId, tx)
        : Promise.resolve(),
    ]);
  }

  async listNotes(
    userId: string,
    itemId?: string,
    projectId?: string,
  ): Promise<NoteEntity[]> {
    return this.notesService.listNotes(userId, itemId, projectId);
  }

  async createNote(userId: string, data: CreateNoteData): Promise<NoteEntity> {
    return this.notesService.createNote(userId, data);
  }

  async listCollections(
    userId: string,
    projectId?: string,
  ): Promise<
    Awaited<ReturnType<CollectionsService['getCollections']>>['collections']
  > {
    const res = await this.collectionsService.getCollections(userId, projectId);
    return res.collections;
  }

  async assignItemsToCollection(
    userId: string,
    collectionId: string,
    itemIds: string[],
    projectId?: string,
  ): Promise<unknown> {
    return this.collectionsService.assignItemsToCollection(
      userId,
      collectionId,
      { itemIds },
      projectId,
    );
  }

  async findMatchCandidates(
    scope: { userId?: string; projectId?: string | null },
    criteria: {
      doi?: string | null;
      arxivId?: string | null;
      pmid?: string | null;
      isbn?: string | null;
      year?: number | null;
      titleWords?: string[];
      titlePrefix?: string;
    },
  ) {
    return this.queryService.findMatchCandidates(scope, criteria);
  }

  async findAttachmentByFileId(
    fileId: string,
    scope?: { userId?: string; projectId?: string },
  ): Promise<{ id: string; itemId: string; metadata?: unknown } | null> {
    if (!this.curationService) return null;
    return this.curationService.findAttachmentByFileId(fileId, scope);
  }

  async updateAttachmentProcessingStatus(
    attachmentId: string,
    status: string,
    metadataPatch?: Record<string, unknown>,
    scope?: { userId?: string; projectId?: string },
  ): Promise<void> {
    if (!this.curationService) return;
    await this.curationService.updateAttachmentProcessingStatus(
      attachmentId,
      status,
      metadataPatch,
      scope,
    );
  }

  async updateItemAiMetadata(
    itemId: string,
    aiMetadataPatch: Record<string, unknown>,
    scope?: { userId?: string; projectId?: string },
  ): Promise<void> {
    if (!this.curationService) return;
    await this.curationService.updateItemAiMetadata(itemId, aiMetadataPatch, scope);
  }

  async invalidateForWrite(params: {
    userId: string;
    projectId?: string | null;
    itemIds?: string[];
    additionalProjectIds?: Array<string | null | undefined>;
    skipScopeInvalidation?: boolean;
    onlyUserStateOverlay?: boolean;
    preserveContentCaches?: boolean;
  }): Promise<void> {
    if (!this.cacheCoordinator) return;
    await this.cacheCoordinator.invalidateForWrite(params);
  }
}

export type { DuplicateCandidateItem };
