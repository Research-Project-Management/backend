import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { CollectionsService } from './collections.service';
import {
  CreateCollectionDto,
  UpdateCollectionDto,
  MoveItemsDto,
  ReorderCollectionsDto,
  AssignItemsToCollectionDto,
} from './dto/collections.dto';
import { CollectionDeleteStrategy } from './types/collections.types';

import { JwtAuthGuard } from '@/modules/iam/authn/guards/jwt-auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/current-user.decorator';
import { WorkspaceRoleGuard } from '@/modules/iam/authz/guards/workspace-role.guard';
import { WorkspaceRoles } from '@/modules/iam/authz/decorators/workspace-roles.decorator';

@ApiTags('Library Collections')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard)
export class CollectionsController {
  constructor(private readonly collectionsService: CollectionsService) {}

  @Get([
    'workspace/:workspaceId/library/collections',
    'library/collections/:workspaceId',
    'library/:workspaceId/collections',
  ])
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({ summary: 'Get all collections in workspace' })
  async getCollections(@Param('workspaceId') workspaceId: string) {
    return this.collectionsService.getCollections(workspaceId);
  }

  @Get([
    'workspace/:workspaceId/library/collections/tree',
    'library/collections/:workspaceId/tree',
    'library/:workspaceId/collections/tree',
  ])
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({ summary: 'Get full hierarchical collection tree' })
  async getCollectionTree(@Param('workspaceId') workspaceId: string) {
    return this.collectionsService.getCollectionTree(workspaceId);
  }

  @Post([
    'workspace/:workspaceId/library/collections',
    'library/collections/:workspaceId',
    'library/:workspaceId/collections',
  ])
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  @ApiOperation({ summary: 'Create a new collection' })
  async createCollection(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateCollectionDto,
  ) {
    return this.collectionsService.createCollection(workspaceId, userId, dto);
  }

  @Get([
    'workspace/:workspaceId/library/collections/:collectionId',
    'library/collections/:workspaceId/:collectionId',
    'library/:workspaceId/collections/:collectionId',
  ])
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({ summary: 'Get collection details by ID' })
  async getCollectionById(
    @Param('workspaceId') workspaceId: string,
    @Param('collectionId') collectionId: string,
  ) {
    return this.collectionsService.getCollectionById(workspaceId, collectionId);
  }

  @Put([
    'workspace/:workspaceId/library/collections/:collectionId',
    'library/collections/:workspaceId/:collectionId',
    'library/:workspaceId/collections/:collectionId',
  ])
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  @ApiOperation({ summary: 'Update collection details' })
  async updateCollection(
    @Param('workspaceId') workspaceId: string,
    @Param('collectionId') collectionId: string,
    @Body() dto: UpdateCollectionDto,
  ) {
    return this.collectionsService.updateCollection(
      workspaceId,
      collectionId,
      dto,
    );
  }

  @Delete([
    'workspace/:workspaceId/library/collections/:collectionId',
    'library/collections/:workspaceId/:collectionId',
    'library/:workspaceId/collections/:collectionId',
  ])
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  @ApiOperation({ summary: 'Delete collection' })
  async deleteCollection(
    @Param('workspaceId') workspaceId: string,
    @Param('collectionId') collectionId: string,
    @Query('strategy') strategy?: CollectionDeleteStrategy,
  ) {
    return this.collectionsService.deleteCollection(
      workspaceId,
      collectionId,
      strategy,
    );
  }

  @Post([
    'workspace/:workspaceId/library/collections/:collectionId/move-items',
    'workspace/:workspaceId/library/collections/:collectionId/move-papers',
    'library/collections/:workspaceId/:collectionId/move-papers',
    'library/:workspaceId/collections/:collectionId/move-papers',
  ])
  @HttpCode(HttpStatus.OK)
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  @ApiOperation({ summary: 'Bulk move items to a collection or unfile them' })
  async moveItems(
    @Param('workspaceId') workspaceId: string,
    @Param('collectionId') collectionId: string,
    @Body() dto: MoveItemsDto,
  ) {
    const moveFn =
      (this.collectionsService as any).moveItems ||
      (this.collectionsService as any).movePapers;
    return await moveFn.call(
      this.collectionsService,
      workspaceId,
      collectionId,
      dto.itemIds || dto.paperIds || [],
    );
  }

  // Backward compatibility alias for controller
  async movePapers(
    workspaceId: string,
    collectionId: string,
    dto: MoveItemsDto,
  ) {
    return this.moveItems(workspaceId, collectionId, dto);
  }

  @Patch([
    'workspace/:workspaceId/library/collections/reorder',
    'library/collections/:workspaceId/reorder',
    'library/:workspaceId/collections/reorder',
  ])
  @HttpCode(HttpStatus.OK)
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  @ApiOperation({ summary: 'Reorder or reparent collections in hierarchy' })
  async reorderCollections(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: ReorderCollectionsDto,
  ) {
    return this.collectionsService.reorderCollections(
      workspaceId,
      dto.collections,
    );
  }

  @Post([
    'workspace/:workspaceId/library/collections/:collectionId/items',
    'workspace/:workspaceId/library/collections/:collectionId/papers',
    'library/collections/:workspaceId/:collectionId/papers',
    'library/:workspaceId/collections/:collectionId/papers',
  ])
  @HttpCode(HttpStatus.OK)
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  @ApiOperation({ summary: 'Link items from library to a collection' })
  async assignItemsToCollection(
    @Param('workspaceId') workspaceId: string,
    @Param('collectionId') collectionId: string,
    @Body() dto: AssignItemsToCollectionDto,
  ) {
    const assignFn =
      (this.collectionsService as any).assignItemsToCollection ||
      (this.collectionsService as any).assignPapersToCollection;
    return await assignFn.call(
      this.collectionsService,
      workspaceId,
      collectionId,
      dto,
    );
  }

  // Backward compatibility alias for controller
  async assignPapersToCollection(
    workspaceId: string,
    collectionId: string,
    dto: AssignItemsToCollectionDto,
  ) {
    return this.assignItemsToCollection(workspaceId, collectionId, dto);
  }

  @Delete([
    'workspace/:workspaceId/library/collections/:collectionId/items/:itemId',
    'workspace/:workspaceId/library/collections/:collectionId/papers/:itemId',
    'library/collections/:workspaceId/:collectionId/papers/:itemId',
    'library/:workspaceId/collections/:collectionId/papers/:itemId',
  ])
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  @ApiOperation({
    summary: 'Soft-detach item from collection (preserves item in library)',
  })
  async detachItemFromCollection(
    @Param('workspaceId') workspaceId: string,
    @Param('collectionId') collectionId: string,
    @Param('itemId') itemId: string,
  ) {
    const detachFn =
      (this.collectionsService as any).detachItemFromCollection ||
      (this.collectionsService as any).detachPaperFromCollection;
    return await detachFn.call(
      this.collectionsService,
      workspaceId,
      collectionId,
      itemId,
    );
  }

  // Backward compatibility alias for controller
  async detachPaperFromCollection(
    workspaceId: string,
    collectionId: string,
    itemId: string,
  ) {
    return this.detachItemFromCollection(workspaceId, collectionId, itemId);
  }
}
