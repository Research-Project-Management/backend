import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  Headers,
  Req,
  UseGuards,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { isUUID } from 'class-validator';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import { ProjectRoleGuard, ProjectRoles } from '@/modules/project/access';
import { normalizeProjectScopeId } from '@/modules/library/core';
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

export type ItemsListQuery = CursorPaginationQueryDto & {
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
  projectId?: string;
};

@ApiTags('Library Items')
@ApiBearerAuth('JWT-auth')
@Controller([
  'api/v1/library/items',
  'api/v1/projects/:projectId/library/items',
])
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class ItemsController {
  constructor(
    protected readonly itemService: ItemService,
    protected readonly queryService: ItemQueryService,
    protected readonly curationService: ItemCurationService,
  ) {}

  protected extractAccessHint(req?: RequestWithAccessHint) {
    if (!req) return undefined;
    const ctx = req.accessContext || req.projectMember;
    return {
      role: ctx?.role || req.role,
      permissionOverrides: ctx?.permissionOverrides,
      effectivePermissions: ctx?.effectivePermissions || req.permissions,
    };
  }

  @Get()
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'List library items' })
  async listItems(
    @CurrentUser('id') userId: string,
    @Query() query?: ItemsListQuery,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectScopeId(
      paramProjectId || queryProjectId || query?.projectId,
    );

    const effectiveOrderBy = query?.orderBy ?? query?.sortBy;
    const effectiveOrderDirection = query?.orderDirection ?? query?.sortOrder;
    const effectiveFromYear = query?.fromYear ?? query?.year;
    const effectiveToYear = query?.toYear ?? query?.year;
    const effectiveTag =
      query?.tag ??
      (Array.isArray(query?.tags) && query.tags.length > 0
        ? query.tags.join(',')
        : undefined);
    const effectiveHasFile = query?.hasFile ?? query?.hasPdf;
    const effectiveOnlyFlagged =
      query?.onlyFlagged ?? query?.isFavorite ?? query?.isStarred;
    const effectiveView =
      query?.view ?? (query?.unfiled ? 'unfiled' : undefined);
    const effectiveReadStatus =
      query?.readStatus ??
      (query?.isRead === true
        ? 'completed'
        : query?.isRead === false
          ? 'unread'
          : undefined);

    const listOptions = {
      view: effectiveView,
      collectionId: query?.collectionId,
      tagId: query?.tagId,
      search: query?.search,
      ...(query?.searchMode !== undefined ? { searchMode: query.searchMode } : {}),
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
      ...(effectiveReadStatus !== undefined
        ? { readStatus: effectiveReadStatus }
        : {}),
      ...(effectiveHasFile !== undefined ? { hasFile: effectiveHasFile } : {}),
      ...(query?.hasNotes !== undefined ? { hasNotes: query.hasNotes } : {}),
      ...(effectiveOnlyFlagged !== undefined
        ? { onlyFlagged: effectiveOnlyFlagged }
        : {}),
      ...(query?.isRetracted !== undefined
        ? { isRetracted: query.isRetracted }
        : {}),
      ...(effectiveTag !== undefined ? { tag: effectiveTag } : {}),
      ...(query?.collectionIds !== undefined
        ? { collectionIds: query.collectionIds }
        : {}),
      ...(query?.includeSubcollections !== undefined
        ? { includeSubcollections: query.includeSubcollections }
        : {}),
      ...(query?.recursive !== undefined ? { recursive: query.recursive } : {}),
      ...(query?.fields !== undefined ? { fields: query.fields } : {}),
    };

    const result = await this.queryService.listItems(userId, listOptions);
    return { items: result.items, pagination: result.meta, meta: result.meta };
  }

  @Get('counts')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get summary item counts' })
  async getCounts(
    @CurrentUser('id') userId: string,
    @Query('projectId') queryProjectId?: string,
    @Req() req?: RequestWithAccessHint,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);
    return this.queryService.getCounts(
      userId,
      projectId,
      this.extractAccessHint(req),
    );
  }

  @Post('import')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Import items from user library into project' })
  async importItems(
    @CurrentUser('id') userId: string,
    @Param('projectId') paramProjectId: string,
    @Body() body: { itemIds: string[] },
    @Query('projectId') queryProjectId?: string,
  ) {
    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);
    if (!projectId) {
      throw new BadRequestException(
        'Project ID is required in URL parameter to import items',
      );
    }
    if (!Array.isArray(body?.itemIds) || body.itemIds.length === 0 || body.itemIds.length > 100) {
      throw new BadRequestException('itemIds must be a non-empty array of at most 100 IDs');
    }
    return this.curationService.importItemsToProject(
      userId,
      projectId,
      body.itemIds,
    );
  }

  @Get(':id')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get a library item by ID' })
  async getItem(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    if (!isUUID(id)) {
      throw new NotFoundException(`Item ${id} not found in library`);
    }
    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);
    const item = await this.queryService.getItem(userId, id, projectId);
    if (!item) {
      throw new NotFoundException(`Item ${id} not found in library`);
    }
    return item;
  }

  @Get(':id/collections')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get collections containing this item' })
  async getItemCollections(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);
    const item = await this.itemService.getItem(userId, id, projectId);
    if (!item) {
      throw new NotFoundException(`Item with ID ${id} not found`);
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

  @Get(':id/metadata-sources')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get raw provenance metadata sources for an item' })
  async getMetadataSources(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    if (!isUUID(id)) {
      throw new NotFoundException(`Item ${id} not found in library`);
    }
    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);
    return this.curationService.getMetadataSources(userId, id, projectId);
  }

  @Post()
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Create a new library item' })
  async createItem(
    @CurrentUser('id') userId: string,
    @Query('projectId') queryProjectId: string | undefined,
    @Body() body: CreateItemDto,
    @Headers('x-idempotency-key') idempotencyKey?: string,
    @Headers('x-correlation-id') correlationId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = normalizeProjectScopeId(
      paramProjectId || queryProjectId || body?.projectId,
    );
    return this.itemService.createItem(
      userId,
      { ...body },
      {
        projectId: effectiveProjectId,
        source: 'manual',
        idempotencyKey,
        correlationId,
      },
      effectiveProjectId,
    );
  }

  @Patch(':id')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Update a library item' })
  async updateItem(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: UpdateItemDto | undefined,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);

    const parsedHeaderVersion = ifMatch
      ? parseInt(ifMatch.replace(/["']/g, ''), 10)
      : undefined;
    const expectedVersion =
      body?.expectedVersion !== undefined
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
    const { expectedVersion: _, ...updateData } = body || {};
    return this.itemService.updateItem(
      userId,
      id,
      expectedVersion,
      updateData,
      undefined,
      projectId,
    );
  }

  @Put(':id')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Replace a library item' })
  async replaceItem(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: UpdateItemDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    return this.updateItem(
      id,
      userId,
      ifMatch,
      body,
      queryProjectId,
      paramProjectId,
    );
  }

  @Delete(':id')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Delete a library item (soft delete)' })
  async deleteItem(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Headers('if-match') ifMatch?: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    if (!isUUID(id)) {
      throw new NotFoundException('Invalid item ID format');
    }
    const expectedVersion = ifMatch
      ? parseInt(ifMatch.replace(/["']/g, ''), 10)
      : undefined;
    if (expectedVersion !== undefined && (Number.isNaN(expectedVersion) || expectedVersion < 0)) {
      throw new BadRequestException('Invalid expectedVersion');
    }
    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);

    const deleted = await this.itemService.deleteItem(
      userId,
      id,
      expectedVersion,
      undefined,
      projectId,
    );
    return { success: true, deleted, id };
  }

  @Post(':id/restore')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Restore a deleted item' })
  async restoreItem(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Query('expectedVersion') expectedVersionQuery?: string,
    @Headers('if-match') ifMatch?: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
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
    if (expectedVersion !== undefined && (Number.isNaN(expectedVersion) || expectedVersion < 0)) {
      throw new BadRequestException('Invalid expectedVersion');
    }
    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);

    const restored = await this.itemService.restoreItem(
      userId,
      id,
      expectedVersion,
      projectId,
    );
    return { success: true, data: restored, item: restored };
  }

  @Delete(':id/purge')
  @ProjectRoles('owner')
  @ApiOperation({ summary: 'Permanently purge a deleted item' })
  async purgeItem(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    if (!isUUID(id)) {
      throw new NotFoundException(`Item ${id} not found`);
    }
    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);
    const purged = await this.itemService.purgeItem(userId, id, projectId);
    return { success: true, purged, id };
  }

  @Post('bulk-purge')
  @ProjectRoles('owner')
  @ApiOperation({ summary: 'Permanently purge multiple deleted items in batch' })
  async bulkPurgeItems(
    @CurrentUser('id') userId: string,
    @Body() body: BulkPurgeItemsDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);
    return this.itemService.bulkPurge(userId, body?.itemIds || [], projectId);
  }

  @Post('bulk-trash')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Move multiple library items to trash in batch' })
  async bulkTrashItems(
    @CurrentUser('id') userId: string,
    @Body() body: BulkTrashItemsDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);
    return this.itemService.bulkTrash(userId, body?.itemIds || [], projectId);
  }

  @Post('bulk-restore')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Restore multiple library items from trash in batch' })
  async bulkRestoreItems(
    @CurrentUser('id') userId: string,
    @Body() body: BulkRestoreItemsDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);
    return this.itemService.bulkRestore(userId, body?.itemIds || [], projectId);
  }
}

@ApiTags('Library Permissions')
@ApiBearerAuth('JWT-auth')
@Controller(['api/v1/library', 'api/v1/projects/:projectId/library'])
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class LibraryPermissionsController {
  constructor(private readonly queryService: ItemQueryService) {}

  private extractAccessHint(req?: RequestWithAccessHint) {
    if (!req) return undefined;
    const ctx = req.accessContext || req.projectMember;
    return {
      role: ctx?.role || req.role,
      permissionOverrides: ctx?.permissionOverrides,
      effectivePermissions: ctx?.effectivePermissions || req.permissions,
    };
  }

  @Get('permissions')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({
    summary:
      'Get authoritative library permissions for personal or project scope',
  })
  async getLibraryPermissions(
    @CurrentUser('id') userId: string,
    @Param('projectId') paramProjectId?: string,
    @Query('projectId') queryProjectId?: string,
    @Req() req?: RequestWithAccessHint,
  ) {
    const projectId = normalizeProjectScopeId(paramProjectId || queryProjectId);
    return this.queryService.getPermissions(
      userId,
      projectId,
      this.extractAccessHint(req),
    );
  }
}
