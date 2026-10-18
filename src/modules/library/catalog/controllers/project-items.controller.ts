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
import {
  BaseItemController,
  RequestWithAccessHint,
} from './base-item.controller';

/**
 * Project Library Items Controller (Project Scope).
 * Handles project-scoped items (/api/v1/projects/:projectId/library/items).
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
@Controller(['api/v1/library', 'api/v1/projects/:projectId/library'])
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
