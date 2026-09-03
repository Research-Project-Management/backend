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
import { CurrentWorkspace } from '../../../modules/iam/authz/decorators/current-workspace.decorator';
import { WorkspaceRoleGuard } from '../../../modules/iam/authz/guards/workspace-role.guard';
import { WorkspaceRoles } from '../../../modules/iam/authz/decorators/workspace-roles.decorator';

@Controller('api/v1/workspaces/:workspaceId/library/collections')
@UseGuards(JwtAuthGuard)
export class CollectionsController {
  constructor(private readonly collectionsService: CollectionsService) {}

  @Get()
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  async getCollections(
    @Param('workspaceId') workspaceId: string,
    @CurrentWorkspace() currentWorkspaceId: string,
  ) {
    const targetWsId = currentWorkspaceId || workspaceId;
    return this.collectionsService.getCollections(targetWsId);
  }

  @Get('tree')
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  async getCollectionTree(
    @Param('workspaceId') workspaceId: string,
    @CurrentWorkspace() currentWorkspaceId: string,
  ) {
    const targetWsId = currentWorkspaceId || workspaceId;
    return this.collectionsService.getCollectionTree(targetWsId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  async createCollection(
    @Param('workspaceId') workspaceId: string,
    @CurrentWorkspace() currentWorkspaceId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateCollectionDto,
  ) {
    const targetWsId = currentWorkspaceId || workspaceId;
    return this.collectionsService.createCollection(targetWsId, userId, dto);
  }

  @Get(':collectionId')
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  async getCollectionById(
    @Param('workspaceId') workspaceId: string,
    @CurrentWorkspace() currentWorkspaceId: string,
    @Param('collectionId') collectionId: string,
  ) {
    const targetWsId = currentWorkspaceId || workspaceId;
    return this.collectionsService.getCollectionById(targetWsId, collectionId);
  }

  @Put(':collectionId')
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  async updateCollection(
    @Param('workspaceId') workspaceId: string,
    @CurrentWorkspace() currentWorkspaceId: string,
    @Param('collectionId') collectionId: string,
    @Body() dto: UpdateCollectionDto,
  ) {
    const targetWsId = currentWorkspaceId || workspaceId;
    return this.collectionsService.updateCollection(
      targetWsId,
      collectionId,
      dto,
    );
  }

  @Delete(':collectionId')
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  async deleteCollection(
    @Param('workspaceId') workspaceId: string,
    @CurrentWorkspace() currentWorkspaceId: string,
    @Param('collectionId') collectionId: string,
    @Query('strategy') strategy?: CollectionDeleteStrategy,
  ) {
    const targetWsId = currentWorkspaceId || workspaceId;
    return this.collectionsService.deleteCollection(
      targetWsId,
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
    @CurrentWorkspace() currentWorkspaceId: string,
    @Param('collectionId') collectionId: string,
    @Body() dto: MoveItemsDto,
  ) {
    const targetWsId = currentWorkspaceId || workspaceId;
    return this.collectionsService.moveItems(
      targetWsId,
      collectionId,
      dto.itemIds || [],
    );
  }

  @Patch('reorder')
  @HttpCode(HttpStatus.OK)
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  async reorderCollections(
    @Param('workspaceId') workspaceId: string,
    @CurrentWorkspace() currentWorkspaceId: string,
    @Body() dto: ReorderCollectionsDto,
  ) {
    const targetWsId = currentWorkspaceId || workspaceId;
    return this.collectionsService.reorderCollections(
      targetWsId,
      dto.collections,
    );
  }

  @Post(':collectionId/items')
  @HttpCode(HttpStatus.OK)
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  async assignItemsToCollection(
    @Param('workspaceId') workspaceId: string,
    @CurrentWorkspace() currentWorkspaceId: string,
    @Param('collectionId') collectionId: string,
    @Body() dto: AssignItemsToCollectionDto,
  ) {
    const targetWsId = currentWorkspaceId || workspaceId;
    return this.collectionsService.assignItemsToCollection(
      targetWsId,
      collectionId,
      dto,
    );
  }

  @Delete(':collectionId/items/:itemId')
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  async detachItemFromCollection(
    @Param('workspaceId') workspaceId: string,
    @CurrentWorkspace() currentWorkspaceId: string,
    @Param('collectionId') collectionId: string,
    @Param('itemId') itemId: string,
  ) {
    const targetWsId = currentWorkspaceId || workspaceId;
    return this.collectionsService.detachItemFromCollection(
      targetWsId,
      collectionId,
      itemId,
    );
  }
}
