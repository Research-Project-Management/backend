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
  ParseUUIDPipe,
  Optional,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
} from '@nestjs/swagger';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import { ProjectRoleGuard, ProjectRoles } from '@/modules/project/access';
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

interface RequestWithAccessHint {
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
        ? query.tags[0]
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

/**
 * Personal Library Items Controller (Personal Scope).
 * Handles personal items for authenticated user (/api/v1/library/items, /api/v1/me/library/items).
 * Guarded purely by JwtAuthGuard — no project role checks or project ID parsing required.
 */
@ApiTags('Library Items - Personal Catalog')
@ApiBearerAuth('JWT-auth')
@Controller(['api/v1/library/items', 'api/v1/me/library/items'])
@UseGuards(JwtAuthGuard)
export class ItemController extends BaseItemController {
  constructor(
    itemService: ItemService,
    @Optional() queryService?: ItemQueryService,
    @Optional() curationService?: ItemCurationService,
  ) {
    super(itemService, queryService, curationService);
  }

  @Get()
  @ApiOperation({ summary: 'List personal library items' })
  async listItems(
    @CurrentUser('id') userId: string,
    @Query()
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
    @Query('projectId') projectId?: string,
  ) {
    return this.executeListItems(userId, query, projectId);
  }

  @Get('counts')
  @ApiOperation({ summary: 'Get summary item counts for personal views' })
  async getCounts(
    @CurrentUser('id') userId: string,
    @Query('projectId') projectId?: string,
    @Req() req?: RequestWithAccessHint,
  ) {
    return this.executeGetCounts(userId, projectId, req);
  }

  @Get('permissions')
  @ApiOperation({
    summary:
      'Get authoritative library permissions for personal or project scope',
  })
  async getPermissions(
    @CurrentUser('id') userId: string,
    @Query('projectId') projectId?: string,
    @Req() req?: RequestWithAccessHint,
  ) {
    return this.executeGetPermissions(userId, projectId, req);
  }

  @Post('import')
  @ApiOperation({ summary: 'Import items into personal library' })
  async importItems(
    @CurrentUser('id') userId: string,
    @Param('projectId') projectId: string | undefined,
    @Body() body: { itemIds: string[] },
  ) {
    return this.executeImportItems(userId, projectId, body);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a personal library item by ID' })
  async getItem(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Query('projectId') projectId?: string,
  ) {
    return this.executeGetItem(id, userId, projectId);
  }

  @Get(':id/collections')
  @ApiOperation({ summary: 'Get collections containing this personal item' })
  async getItemCollections(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    return this.executeGetItemCollections(
      userId,
      id,
      paramProjectId || queryProjectId,
    );
  }

  @Get(':id/metadata-sources')
  @ApiOperation({
    summary: 'Get raw provenance metadata sources for a personal item',
  })
  async getMetadataSources(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Query('projectId') projectId?: string,
  ) {
    return this.executeGetMetadataSources(id, userId, projectId);
  }

  @Post()
  @ApiOperation({ summary: 'Create a new personal library item' })
  async createItem(
    @CurrentUser('id') userId: string,
    @Query('projectId') projectId: string | undefined,
    @Body() body: CreateItemDto,
    @Headers('x-idempotency-key') idempotencyKey?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    return this.executeCreateItem(
      userId,
      body,
      projectId,
      idempotencyKey,
      correlationId,
    );
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a personal library item' })
  async updateItem(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: UpdateItemDto,
    @Query('projectId') projectId?: string,
  ) {
    return this.executeUpdateItem(id, userId, ifMatch, body, projectId);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Replace a personal library item' })
  async replaceItem(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: UpdateItemDto,
    @Query('projectId') projectId?: string,
  ) {
    return this.updateItem(id, userId, ifMatch, body, projectId);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a personal item (soft delete)' })
  async deleteItem(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Headers('if-match') ifMatch?: string,
    @Query('projectId') projectId?: string,
  ) {
    return this.executeDeleteItem(id, userId, ifMatch, projectId);
  }

  @Post(':id/restore')
  @ApiOperation({ summary: 'Restore a deleted personal item' })
  async restoreItem(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Query('expectedVersion') expectedVersionQuery?: string,
    @Headers('if-match') ifMatch?: string,
    @Query('projectId') projectId?: string,
  ) {
    return this.executeRestoreItem(
      id,
      userId,
      expectedVersionQuery,
      ifMatch,
      projectId,
    );
  }

  @Delete(':id/purge')
  @ApiOperation({ summary: 'Permanently purge a personal deleted item' })
  async purgeItem(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Query('projectId') projectId?: string,
  ) {
    return this.executePurgeItem(id, userId, projectId);
  }

  @Post('bulk-purge')
  @ApiOperation({
    summary: 'Permanently purge multiple personal deleted items in batch',
  })
  async bulkPurgeItems(
    @CurrentUser('id') userId: string,
    @Body() body: BulkPurgeItemsDto,
    @Query('projectId') projectId?: string,
  ) {
    return this.executeBulkPurgeItems(userId, body, projectId);
  }

  @Post('bulk-trash')
  @ApiOperation({
    summary: 'Move multiple personal library items to trash in batch',
  })
  async bulkTrashItems(
    @CurrentUser('id') userId: string,
    @Body() body: BulkTrashItemsDto,
    @Query('projectId') projectId?: string,
  ) {
    return this.executeBulkTrashItems(userId, body, projectId);
  }

  @Post('bulk-restore')
  @ApiOperation({
    summary: 'Restore multiple personal library items from trash in batch',
  })
  async bulkRestoreItems(
    @CurrentUser('id') userId: string,
    @Body() body: BulkRestoreItemsDto,
    @Query('projectId') projectId?: string,
  ) {
    return this.executeBulkRestoreItems(userId, body, projectId);
  }
}

/**
 * Project Library Items Controller (Project Scope).
 * Handles project-scoped library items (/api/v1/projects/:projectId/library/items).
 * Strictly enforces ParseUUIDPipe on :projectId and verifies access with ProjectRoleGuard.
 */
@ApiTags('Library Items - Project Catalog')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/projects/:projectId/library/items')
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class ProjectItemController extends BaseItemController {
  constructor(
    itemService: ItemService,
    @Optional() queryService?: ItemQueryService,
    @Optional() curationService?: ItemCurationService,
  ) {
    super(itemService, queryService, curationService);
  }

  @Get()
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'List project library items' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async listItems(
    @CurrentUser('id') userId: string,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Query()
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
  ) {
    return this.executeListItems(userId, query, projectId);
  }

  @Get('counts')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get summary item counts for project views' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async getCounts(
    @CurrentUser('id') userId: string,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Req() req?: RequestWithAccessHint,
  ) {
    return this.executeGetCounts(userId, projectId, req);
  }

  @Get('permissions')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({
    summary: 'Get authoritative library permissions for project scope',
  })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async getPermissions(
    @CurrentUser('id') userId: string,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Req() req?: RequestWithAccessHint,
  ) {
    return this.executeGetPermissions(userId, projectId, req);
  }

  @Post('import')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Import items from user library into project' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async importItems(
    @CurrentUser('id') userId: string,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Body() body: { itemIds: string[] },
  ) {
    return this.executeImportItems(userId, projectId, body);
  }

  @Get(':id')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get a project library item by ID' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async getItem(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.executeGetItem(id, userId, projectId);
  }

  @Get(':id/collections')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get collections containing this project item' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async getItemCollections(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.executeGetItemCollections(userId, id, projectId);
  }

  @Get(':id/metadata-sources')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({
    summary: 'Get raw provenance metadata sources for a project item',
  })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async getMetadataSources(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.executeGetMetadataSources(id, userId, projectId);
  }

  @Post()
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Create a new project library item' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async createItem(
    @CurrentUser('id') userId: string,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Body() body: CreateItemDto,
    @Headers('x-idempotency-key') idempotencyKey?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    return this.executeCreateItem(
      userId,
      body,
      projectId,
      idempotencyKey,
      correlationId,
    );
  }

  @Patch(':id')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Update a project library item' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async updateItem(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: UpdateItemDto,
  ) {
    return this.executeUpdateItem(id, userId, ifMatch, body, projectId);
  }

  @Put(':id')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Replace a project library item' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async replaceItem(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: UpdateItemDto,
  ) {
    return this.updateItem(id, userId, projectId, ifMatch, body);
  }

  @Delete(':id')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Delete a project item (soft delete)' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async deleteItem(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Headers('if-match') ifMatch?: string,
  ) {
    return this.executeDeleteItem(id, userId, ifMatch, projectId);
  }

  @Post(':id/restore')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Restore a deleted project item' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async restoreItem(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Query('expectedVersion') expectedVersionQuery?: string,
    @Headers('if-match') ifMatch?: string,
  ) {
    return this.executeRestoreItem(
      id,
      userId,
      expectedVersionQuery,
      ifMatch,
      projectId,
    );
  }

  @Delete(':id/purge')
  @ProjectRoles('owner')
  @ApiOperation({ summary: 'Permanently purge a project deleted item' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async purgeItem(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.executePurgeItem(id, userId, projectId);
  }

  @Post('bulk-purge')
  @ProjectRoles('owner')
  @ApiOperation({
    summary: 'Permanently purge multiple project deleted items in batch',
  })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async bulkPurgeItems(
    @CurrentUser('id') userId: string,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Body() body: BulkPurgeItemsDto,
  ) {
    return this.executeBulkPurgeItems(userId, body, projectId);
  }

  @Post('bulk-trash')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({
    summary: 'Move multiple project library items to trash in batch',
  })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async bulkTrashItems(
    @CurrentUser('id') userId: string,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Body() body: BulkTrashItemsDto,
  ) {
    return this.executeBulkTrashItems(userId, body, projectId);
  }

  @Post('bulk-restore')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({
    summary: 'Restore multiple project library items from trash in batch',
  })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async bulkRestoreItems(
    @CurrentUser('id') userId: string,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Body() body: BulkRestoreItemsDto,
  ) {
    return this.executeBulkRestoreItems(userId, body, projectId);
  }
}

/**
 * Dedicated Library Scope Permissions Controller
 * Handles GET /api/v1/library/permissions and GET /api/v1/projects/:projectId/library/permissions.
 */
@ApiTags('Library Permissions')
@ApiBearerAuth('JWT-auth')
@Controller([
  'api/v1/library',
  'api/v1/me/library',
  'api/v1/projects/:projectId/library',
])
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class LibraryPermissionsController extends BaseItemController {
  constructor(
    itemService: ItemService,
    @Optional() queryService?: ItemQueryService,
    @Optional() curationService?: ItemCurationService,
  ) {
    super(itemService, queryService, curationService);
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
    const effectiveProjectId = paramProjectId || queryProjectId;
    return this.executeGetPermissions(userId, effectiveProjectId, req);
  }
}

export { ItemController as ItemsController };
