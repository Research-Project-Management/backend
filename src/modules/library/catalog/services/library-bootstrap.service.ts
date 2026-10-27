import { Injectable, Optional } from '@nestjs/common';
import { normalizeProjectScopeId } from '@/modules/library/core';
import { TransactionService } from '@/modules/library/sync';
import { QueryRepository } from '@/modules/library/catalog/repositories/query.repository';
import { ItemQueryService } from './item-query.service';
import { CollectionsService } from './collections.service';
import { SavedSearchesService } from './saved-searches.service';
import { TypesService } from './types.service';

export interface LibraryBootstrapOptions {
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

@Injectable()
export class LibraryBootstrapService {
  constructor(
    private readonly queryRepo: QueryRepository,
    private readonly itemQueryService: ItemQueryService,
    private readonly collectionsService: CollectionsService,
    private readonly savedSearchesService: SavedSearchesService,
    private readonly typesService: TypesService,
    @Optional() private readonly libraryTx?: TransactionService,
  ) {}

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
    const syncScope = validProjectId ? { projectId: validProjectId } : { userId };

    const [
      counts,
      collectionsResult,
      savedSearches,
      latestSeq,
      feedSubscriptions,
      itemsResult,
    ] = await Promise.all([
      this.itemQueryService.getCounts(userId, validProjectId, accessHint),
      this.collectionsService.getCollections(userId, validProjectId),
      this.savedSearchesService.findAll(userId, validProjectId),
      this.libraryTx
        ? this.libraryTx.getLatestSequence(syncScope).catch(() => 0n)
        : Promise.resolve(0n),
      validProjectId
        ? Promise.resolve([])
        : this.queryRepo.findUserFeedSubscriptions(userId),
      shouldIncludeItems
        ? this.itemQueryService.listItems(userId, {
            ...options,
            projectId: validProjectId,
          })
        : Promise.resolve(undefined),
    ]);

    const snapshot = this.typesService.getSnapshot();
    const itemTypesList = this.typesService.getAllItemTypes();

    return {
      scope: validProjectId ? 'project' : 'user',
      scopeId: validProjectId ?? userId,
      counts,
      collections: collectionsResult.collections,
      savedSearches,
      syncVersion: {
        version: latestSeq.toString(),
        scope: validProjectId ? 'project' : 'user',
        scopeId: validProjectId ?? userId,
      },
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
      feedSubscriptions,
      ...(itemsResult
        ? {
            items: itemsResult.items,
            pagination: itemsResult.meta,
            meta: itemsResult.meta,
          }
        : {}),
    };
  }
}
