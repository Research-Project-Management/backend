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
import { CollectionsService } from './collections.service';
import { CreateCollectionDto } from './dto/create-collection.dto';
import { UpdateCollectionDto } from './dto/update-collection.dto';
import { MoveItemsDto } from './dto/move-items.dto';
import { ReorderCollectionsDto } from './dto/reorder-collections.dto';
import { AssignItemsToCollectionDto } from './dto/assign-items.dto';
import { CollectionDeleteStrategy } from './types/collection.types';
import { JwtAuthGuard } from '../../../modules/iam/authn/guards/jwt-auth.guard';
import { CurrentUser } from '../../../modules/iam/authn/decorators/current-user.decorator';
import { WorkspaceRoleGuard } from '../../../modules/iam/authz/guards/workspace-role.guard';
import { WorkspaceRoles } from '../../../modules/iam/authz/decorators/workspace-roles.decorator';

@Controller([
  'api/v1/workspaces/:workspaceId/library/collections',
  'api/workspace/:workspaceId/library/collections',
  'api/library/collections/:workspaceId',
  'api/library/:workspaceId/collections',
])
@UseGuards(JwtAuthGuard)
export class CollectionsController {
  constructor(private readonly collectionsService: CollectionsService) {}

  @Get()
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  async getCollections(@Param('workspaceId') workspaceId: string) {
    return this.collectionsService.getCollections(workspaceId);
  }

  @Get('tree')
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  async getCollectionTree(@Param('workspaceId') workspaceId: string) {
    return this.collectionsService.getCollectionTree(workspaceId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  async createCollection(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateCollectionDto,
  ) {
    return this.collectionsService.createCollection(workspaceId, userId, dto);
  }

  @Get(':collectionId')
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  async getCollectionById(
    @Param('workspaceId') workspaceId: string,
    @Param('collectionId') collectionId: string,
  ) {
    return this.collectionsService.getCollectionById(workspaceId, collectionId);
  }

  @Put(':collectionId')
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
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

  @Delete(':collectionId')
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
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

  @Post(':collectionId/move-items')
  @HttpCode(HttpStatus.OK)
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  async moveItems(
    @Param('workspaceId') workspaceId: string,
    @Param('collectionId') collectionId: string,
    @Body() dto: MoveItemsDto,
  ) {
    return this.collectionsService.moveItems(
      workspaceId,
      collectionId,
      dto.itemIds || dto.paperIds || [],
    );
  }

  @Post(':collectionId/move-papers')
  @HttpCode(HttpStatus.OK)
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  async movePapers(
    @Param('workspaceId') workspaceId: string,
    @Param('collectionId') collectionId: string,
    @Body() dto: MoveItemsDto,
  ) {
    return this.moveItems(workspaceId, collectionId, dto);
  }

  @Patch('reorder')
  @HttpCode(HttpStatus.OK)
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  async reorderCollections(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: ReorderCollectionsDto,
  ) {
    return this.collectionsService.reorderCollections(
      workspaceId,
      dto.collections,
    );
  }

  @Post([':collectionId/items', ':collectionId/papers'])
  @HttpCode(HttpStatus.OK)
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  async assignItemsToCollection(
    @Param('workspaceId') workspaceId: string,
    @Param('collectionId') collectionId: string,
    @Body() dto: AssignItemsToCollectionDto,
  ) {
    return this.collectionsService.assignItemsToCollection(
      workspaceId,
      collectionId,
      dto,
    );
  }

  @Delete([':collectionId/items/:itemId', ':collectionId/papers/:itemId'])
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  async detachItemFromCollection(
    @Param('workspaceId') workspaceId: string,
    @Param('collectionId') collectionId: string,
    @Param('itemId') itemId: string,
  ) {
    return this.collectionsService.detachItemFromCollection(
      workspaceId,
      collectionId,
      itemId,
    );
  }
}
