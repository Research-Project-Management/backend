import {
  NotFoundException,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import {
  CursorPaginationQueryDto,
  CreateItemDto,
  UpdateItemDto,
  BulkPurgeItemsDto,
  BulkTrashItemsDto,
  BulkRestoreItemsDto,
} from '@/modules/library/catalog/dto/items.dto';
import { ItemService } from '@/modules/library/catalog/services/items.service';
import { ItemQueryService } from '@/modules/library/catalog/services/item-query.service';
import { ItemCurationService } from '@/modules/library/catalog/services/item-curation.service';

export interface RequestWithAccessHint {
  role?: string;
  projectMember?: {
    role?: string;
    permissionOverrides?: Record<string, boolean> | null;
    effectivePermissions?: readonly string[];
  };
  accessContext?: {
    role?: string;
    permissionOverrides?: Record<string, boolean> | null;
    effectivePermissions?: readonly string[];
  };
  permissions?: readonly string[];
}

/**
 * Shared Base Controller for Library Items orchestration.
 * Directly communicates with ItemService for lifecycle mutations and specialized domain services
 * (ItemQueryService for queries, ItemCurationService for scholarly curation) to prevent indirect middleman bottlenecks.
 */
export abstract class BaseItemController {
  constructor(
    protected readonly itemService: ItemService,
    @Optional() protected readonly queryService?: ItemQueryService,
    @Optional() protected readonly curationService?: ItemCurationService,
  ) {}

  protected get queryRunner(): ItemQueryService | ItemService {
    return this.queryService ?? this.itemService;
  }

  protected get curationRunner(): ItemCurationService | ItemService {
    return this.curationService ?? this.itemService;
  }

  protected extractAccessHint(req?: RequestWithAccessHint) {
    if (!req) return undefined;
    const ctx = req.accessContext || req.projectMember;
    return {
      role: ctx?.role || req.role,
      permissionOverrides: ctx?.permissionOverrides,
      effectivePermissions: ctx?.effectivePermissions || req.permissions,
    };
  }

  protected async executeListItems(
    userId: string,
    query?: CursorPaginationQueryDto & {
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
      tagId?: string;
      search?: string;
      fields?: string;
    },
    projectId?: string,
  ) {
    const effectiveOrderBy = query?.orderBy ?? query?.sortBy;
    const effectiveOrderDirection = query?.orderDirection ?? query?.sortOrder;
    const effectiveFromYear = query?.fromYear ?? query?.year;
    const effectiveToYear = query?.toYear ?? query?.year;
    const effectiveTag =
      query?.tag ??
      (Array.isArray(query?.tags) && query.tags.length > 0
        ? query.tags.join(',')
        : undefined);

    const listOptions = {
      view: query?.view,
      collectionId: query?.collectionId,
      tagId: query?.tagId,
      search: query?.search,
      cursor: query?.cursor,
      limit: query?.limit,
      projectId,
      ...(query?.page !== undefined ? { page: query.page } : {}),
      ...(effectiveOrderBy !== undefined ? { orderBy: effectiveOrderBy } : {}),
      ...(effectiveOrderDirection !== undefined
        ? { orderDirection: effectiveOrderDirection }
        : {}),
      ...(query?.itemType !== undefined ? { itemType: query.itemType } : {}),
      ...(query?.type !== undefined ? { type: query.type } : {}),
      ...(effectiveFromYear !== undefined
        ? { fromYear: effectiveFromYear }
        : {}),
      ...(effectiveToYear !== undefined ? { toYear: effectiveToYear } : {}),
      ...(query?.readStatus !== undefined
        ? { readStatus: query.readStatus }
        : {}),
      ...(query?.hasFile !== undefined ? { hasFile: query.hasFile } : {}),
      ...(query?.hasNotes !== undefined ? { hasNotes: query.hasNotes } : {}),
      ...(effectiveTag !== undefined ? { tag: effectiveTag } : {}),
      ...(query?.collectionIds !== undefined
        ? { collectionIds: query.collectionIds }
        : {}),
      ...(query?.includeSubcollections !== undefined
        ? { includeSubcollections: query.includeSubcollections }
        : {}),
      ...(query?.recursive !== undefined ? { recursive: query.recursive } : {}),
    };

    const result = await this.queryRunner.listItems(userId, listOptions);
    return { items: result.items, pagination: result.meta, meta: result.meta };
  }

  protected async executeGetCounts(
    userId: string,
    projectId?: string,
    req?: RequestWithAccessHint,
  ) {
    return this.queryRunner.getCounts(
      userId,
      projectId,
      this.extractAccessHint(req),
    );
  }

  protected async executeGetPermissions(
    userId: string,
    projectId?: string,
    req?: RequestWithAccessHint,
  ) {
    if (typeof this.queryRunner.getPermissions === 'function') {
      return this.queryRunner.getPermissions(
        userId,
        projectId,
        this.extractAccessHint(req),
      );
    }
    const counts = await this.executeGetCounts(userId, projectId, req);
    return {
      scope: projectId ? 'project' : 'personal',
      role: counts.role,
      permissions: counts.permissions,
    };
  }

  protected async executeImportItems(
    userId: string,
    projectId: string | undefined,
    body: { itemIds: string[] },
  ) {
    if (!projectId) {
      throw new BadRequestException(
        'Project ID is required in URL parameter to import items',
      );
    }
    return this.curationRunner.importItemsToProject(
      userId,
      projectId,
      body.itemIds || [],
    );
  }

  protected async executeGetItem(
    id: string,
    userId: string,
    projectId?: string,
  ) {
    if (!isUUID(id)) {
      throw new NotFoundException(`Item ${id} not found in library`);
    }
    const item = await this.queryRunner.getItem(userId, id, projectId);
    if (!item) {
      throw new NotFoundException(`Item ${id} not found in library`);
    }
    return item;
  }

  protected async executeGetItemCollections(
    userId: string,
    itemId: string,
    projectId?: string,
  ) {
    const item = await this.itemService.getItem(userId, itemId, projectId);
    if (!item) {
      throw new NotFoundException(`Item with ID ${itemId} not found`);
    }
    const rawItem = item as typeof item & {
      collectionItems?: Array<{ collection?: unknown }>;
    };
    const collectionItems = rawItem.collectionItems || [];
    const collections = collectionItems
      .map((ci) => ci.collection)
      .filter(Boolean);
    return {
      success: true,
      count: collections.length,
      collections,
      data: collections,
    };
  }

  protected async executeGetMetadataSources(
    id: string,
    userId: string,
    projectId?: string,
  ) {
    if (!isUUID(id)) {
      throw new NotFoundException(`Item ${id} not found in library`);
    }
    return this.curationRunner.getMetadataSources(userId, id, projectId);
  }

  protected async executeCreateItem(
    userId: string,
    body: CreateItemDto,
    projectId?: string,
    idempotencyKey?: string,
    correlationId?: string,
  ) {
    const { crossrefEnriched: _cr, ...cleanBody } = body;
    const effectiveProjectId = projectId || cleanBody.projectId;

    return this.itemService.createItem(
      userId,
      cleanBody,
      {
        projectId: effectiveProjectId,
        source: 'manual',
        idempotencyKey,
        correlationId,
      },
      effectiveProjectId,
    );
  }

  protected async executeUpdateItem(
    id: string,
    userId: string,
    ifMatch: string | undefined,
    body: UpdateItemDto,
    projectId?: string,
  ) {
    const parsedHeaderVersion = ifMatch
      ? parseInt(ifMatch.replace(/["']/g, ''), 10)
      : undefined;
    const expectedVersion =
      body.expectedVersion !== undefined
        ? Number(body.expectedVersion)
        : parsedHeaderVersion !== undefined && !isNaN(parsedHeaderVersion)
          ? parsedHeaderVersion
          : undefined;
    if (
      expectedVersion !== undefined &&
      (isNaN(expectedVersion) || expectedVersion < 0)
    ) {
      throw new BadRequestException('Invalid expectedVersion specified');
    }
    const { expectedVersion: _, crossrefEnriched: _cr, ...updateData } = body;
    return this.itemService.updateItem(
      userId,
      id,
      expectedVersion,
      updateData,
      undefined,
      projectId,
    );
  }

  protected async executeDeleteItem(
    id: string,
    userId: string,
    ifMatch?: string,
    projectId?: string,
  ) {
    if (!isUUID(id)) {
      throw new NotFoundException('Invalid item ID format');
    }
    const expectedVersion = ifMatch
      ? parseInt(ifMatch.replace(/["']/g, ''), 10)
      : undefined;

    const deleted = await this.itemService.deleteItem(
      userId,
      id,
      expectedVersion,
      undefined,
      projectId,
    );
    return { success: true, deleted, id };
  }

  protected async executeRestoreItem(
    id: string,
    userId: string,
    expectedVersionQuery?: string,
    ifMatch?: string,
    projectId?: string,
  ) {
    if (!isUUID(id)) {
      throw new NotFoundException(`Trashed item ${id} not found`);
    }
    const expectedVersion =
      expectedVersionQuery !== undefined
        ? parseInt(expectedVersionQuery, 10)
        : ifMatch
          ? parseInt(ifMatch.replace(/["']/g, ''), 10)
          : undefined;

    const restored = await this.itemService.restoreItem(
      userId,
      id,
      expectedVersion,
      projectId,
    );
    return { success: true, data: restored, item: restored };
  }

  protected async executePurgeItem(
    id: string,
    userId: string,
    projectId?: string,
  ) {
    if (!isUUID(id)) {
      throw new NotFoundException(`Item ${id} not found`);
    }
    const purged = await this.itemService.purgeItem(userId, id, projectId);
    return { success: true, purged, id };
  }

  protected async executeBulkPurgeItems(
    userId: string,
    body: BulkPurgeItemsDto,
    projectId?: string,
  ) {
    const itemIds = body?.itemIds || [];
    return this.itemService.bulkPurge(userId, itemIds, projectId);
  }

  protected async executeBulkTrashItems(
    userId: string,
    body: BulkTrashItemsDto,
    projectId?: string,
  ) {
    const itemIds = body?.itemIds || [];
    return this.itemService.bulkTrash(userId, itemIds, projectId);
  }

  protected async executeBulkRestoreItems(
    userId: string,
    body: BulkRestoreItemsDto,
    projectId?: string,
  ) {
    const itemIds = body?.itemIds || [];
    return this.itemService.bulkRestore(userId, itemIds, projectId);
  }
}
