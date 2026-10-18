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
  Optional,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
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

export {
  BaseItemController,
  type RequestWithAccessHint,
} from './base-item.controller';
export {
  ProjectItemController,
  LibraryPermissionsController,
} from './project-items.controller';

/**
 * Personal Library Items Controller (Personal Scope).
 * Handles personal items for authenticated user (/api/v1/library/items).
 * Guarded purely by JwtAuthGuard — no project role checks or project ID parsing required.
 */
@ApiTags('Library Items - Personal Catalog')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/library/items')
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
