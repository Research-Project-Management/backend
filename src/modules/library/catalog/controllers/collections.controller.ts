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
  BadRequestException,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
} from '@nestjs/swagger';
import { CollectionsService } from '../services/collections.service';
import {
  CreateCollectionDto,
  UpdateCollectionDto,
  MoveItemsDto,
  ReorderCollectionsDto,
  AssignItemsToCollectionDto,
  BulkDetachItemsDto,
} from '../dto/collections.dto';
import { CollectionDeleteStrategy } from '../types/collections.types';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import { isUUID } from 'class-validator';
import { ProjectRoleGuard, ProjectRoles } from '@/modules/project/access';

/**
 * Shared Base Adapter for Library Collections orchestration.
 */
export abstract class BaseCollectionController {
  constructor(protected readonly collectionsService: CollectionsService) {}

  protected async executeGetCollections(userId: string, projectId?: string) {
    return this.collectionsService.getCollections(userId, projectId);
  }

  protected async executeGetCollectionTree(userId: string, projectId?: string) {
    return this.collectionsService.getCollectionTree(userId, projectId);
  }

  protected async executeReorderCollections(
    userId: string,
    dto: ReorderCollectionsDto,
    projectId?: string,
  ) {
    return this.collectionsService.reorderCollections(
      userId,
      dto.collections,
      projectId,
    );
  }

  protected async executeCreateCollection(
    userId: string,
    dto: CreateCollectionDto,
    projectId?: string,
  ) {
    const rawProjectId = projectId || dto.projectId;
    if (rawProjectId && !isUUID(rawProjectId)) {
      throw new BadRequestException('Invalid project ID');
    }
    return this.collectionsService.createCollection(
      userId,
      dto,
      rawProjectId || undefined,
    );
  }

  protected async executeGetCollectionById(
    userId: string,
    collectionId: string,
    projectId?: string,
  ) {
    return this.collectionsService.getCollectionById(
      userId,
      collectionId,
      projectId,
    );
  }

  protected async executeUpdateCollection(
    userId: string,
    collectionId: string,
    dto: UpdateCollectionDto,
    projectId?: string,
  ) {
    return this.collectionsService.updateCollection(
      userId,
      collectionId,
      dto,
      projectId,
    );
  }

  protected async executeDeleteCollection(
    userId: string,
    collectionId: string,
    strategy?: CollectionDeleteStrategy,
    projectId?: string,
  ) {
    return this.collectionsService.deleteCollection(
      userId,
      collectionId,
      strategy,
      projectId,
    );
  }

  protected async executeMoveItems(
    userId: string,
    collectionId: string,
    dto: MoveItemsDto,
    projectId?: string,
  ) {
    return this.collectionsService.moveItems(
      userId,
      collectionId,
      dto.itemIds || dto.paperIds || [],
      projectId,
    );
  }

  protected async executeAssignItemsToCollection(
    userId: string,
    collectionId: string,
    dto: AssignItemsToCollectionDto,
    projectId?: string,
  ) {
    return this.collectionsService.assignItemsToCollection(
      userId,
      collectionId,
      dto,
      projectId,
    );
  }

  protected async executeDetachItemFromCollection(
    userId: string,
    collectionId: string,
    itemId: string,
    projectId?: string,
  ) {
    return this.collectionsService.detachItemFromCollection(
      userId,
      collectionId,
      itemId,
      projectId,
    );
  }

  protected async executeBulkDetachItems(
    userId: string,
    collectionId: string,
    dto: BulkDetachItemsDto,
    projectId?: string,
  ) {
    const itemIds = dto?.itemIds || [];
    return this.collectionsService.detachItemsFromCollection(
      userId,
      collectionId,
      itemIds,
      projectId,
    );
  }
}

/**
 * Personal Collections Controller (/api/v1/library/collections).
 * Guarded purely by JwtAuthGuard — scoped to authenticated user.
 */
@ApiTags('Library Collections - Personal')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/library/collections')
@UseGuards(JwtAuthGuard)
export class CollectionController extends BaseCollectionController {
  constructor(collectionsService: CollectionsService) {
    super(collectionsService);
  }

  @Get()
  @ApiOperation({ summary: 'List all personal collections' })
  async getCollections(
    @CurrentUser('id') userId: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    return this.executeGetCollections(userId, queryProjectId);
  }

  @Get('tree')
  @ApiOperation({ summary: 'Get personal collection tree' })
  async getCollectionTree(
    @CurrentUser('id') userId: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    return this.executeGetCollectionTree(userId, queryProjectId);
  }

  @Patch('reorder')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reorder personal collections' })
  async reorderCollections(
    @CurrentUser('id') userId: string,
    @Body() dto: ReorderCollectionsDto,
    @Query('projectId') queryProjectId?: string,
  ) {
    return this.executeReorderCollections(userId, dto, queryProjectId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create personal collection' })
  async createCollection(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateCollectionDto,
    @Query('projectId') queryProjectId?: string,
  ) {
    return this.executeCreateCollection(userId, dto, queryProjectId);
  }

  @Get(':collectionId')
  @ApiOperation({ summary: 'Get personal collection by ID' })
  async getCollectionById(
    @CurrentUser('id') userId: string,
    @Param('collectionId') collectionId: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    return this.executeGetCollectionById(userId, collectionId, queryProjectId);
  }

  @Put(':collectionId')
  @ApiOperation({ summary: 'Update personal collection' })
  async updateCollection(
    @CurrentUser('id') userId: string,
    @Param('collectionId') collectionId: string,
    @Body() dto: UpdateCollectionDto,
    @Query('projectId') queryProjectId?: string,
  ) {
    return this.executeUpdateCollection(
      userId,
      collectionId,
      dto,
      queryProjectId,
    );
  }

  @Delete(':collectionId')
  @ApiOperation({ summary: 'Delete personal collection' })
  async deleteCollection(
    @CurrentUser('id') userId: string,
    @Param('collectionId') collectionId: string,
    @Query('strategy') strategy?: CollectionDeleteStrategy,
    @Query('projectId') queryProjectId?: string,
  ) {
    return this.executeDeleteCollection(
      userId,
      collectionId,
      strategy,
      queryProjectId,
    );
  }

  @Post(':collectionId/move-items')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Move items to personal collection' })
  async moveItems(
    @CurrentUser('id') userId: string,
    @Param('collectionId') collectionId: string,
    @Body() dto: MoveItemsDto,
    @Query('projectId') queryProjectId?: string,
  ) {
    return this.executeMoveItems(userId, collectionId, dto, queryProjectId);
  }

  @Post(':collectionId/items')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Assign items to personal collection' })
  async assignItemsToCollection(
    @CurrentUser('id') userId: string,
    @Param('collectionId') collectionId: string,
    @Body() dto: AssignItemsToCollectionDto,
    @Query('projectId') queryProjectId?: string,
  ) {
    return this.executeAssignItemsToCollection(
      userId,
      collectionId,
      dto,
      queryProjectId,
    );
  }

  @Delete(':collectionId/items/:itemId')
  @ApiOperation({ summary: 'Detach item from personal collection' })
  async detachItemFromCollection(
    @CurrentUser('id') userId: string,
    @Param('collectionId') collectionId: string,
    @Param('itemId') itemId: string,
    @Query('projectId') queryProjectId?: string,
  ) {
    return this.executeDetachItemFromCollection(
      userId,
      collectionId,
      itemId,
      queryProjectId,
    );
  }

  @Post(':collectionId/items/bulk-detach')
  @ApiOperation({
    summary: 'Detach multiple items from personal collection in batch',
  })
  async bulkDetachItems(
    @CurrentUser('id') userId: string,
    @Param('collectionId') collectionId: string,
    @Body() dto: BulkDetachItemsDto,
    @Query('projectId') queryProjectId?: string,
  ) {
    return this.executeBulkDetachItems(
      userId,
      collectionId,
      dto,
      queryProjectId,
    );
  }
}

/**
 * Project Collections Controller (/api/v1/projects/:projectId/library/collections).
 * Strictly validates :projectId with ParseUUIDPipe and enforces project roles.
 */
@ApiTags('Library Collections - Project')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/projects/:projectId/library/collections')
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class ProjectCollectionController extends BaseCollectionController {
  constructor(collectionsService: CollectionsService) {
    super(collectionsService);
  }

  @Get()
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'List all project collections' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async getCollections(
    @CurrentUser('id') userId: string,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.executeGetCollections(userId, projectId);
  }

  @Get('tree')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get project collection tree' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async getCollectionTree(
    @CurrentUser('id') userId: string,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.executeGetCollectionTree(userId, projectId);
  }

  @Patch('reorder')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reorder project collections' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async reorderCollections(
    @CurrentUser('id') userId: string,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Body() dto: ReorderCollectionsDto,
  ) {
    return this.executeReorderCollections(userId, dto, projectId);
  }

  @Post()
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create project collection' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async createCollection(
    @CurrentUser('id') userId: string,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Body() dto: CreateCollectionDto,
  ) {
    return this.executeCreateCollection(userId, dto, projectId);
  }

  @Get(':collectionId')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get project collection by ID' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async getCollectionById(
    @CurrentUser('id') userId: string,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Param('collectionId') collectionId: string,
  ) {
    return this.executeGetCollectionById(userId, collectionId, projectId);
  }

  @Put(':collectionId')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Update project collection' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async updateCollection(
    @CurrentUser('id') userId: string,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Param('collectionId') collectionId: string,
    @Body() dto: UpdateCollectionDto,
  ) {
    return this.executeUpdateCollection(userId, collectionId, dto, projectId);
  }

  @Delete(':collectionId')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Delete project collection' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async deleteCollection(
    @CurrentUser('id') userId: string,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Param('collectionId') collectionId: string,
    @Query('strategy') strategy?: CollectionDeleteStrategy,
  ) {
    return this.executeDeleteCollection(
      userId,
      collectionId,
      strategy,
      projectId,
    );
  }

  @Post(':collectionId/move-items')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Move items to project collection' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async moveItems(
    @CurrentUser('id') userId: string,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Param('collectionId') collectionId: string,
    @Body() dto: MoveItemsDto,
  ) {
    return this.executeMoveItems(userId, collectionId, dto, projectId);
  }

  @Post(':collectionId/items')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Assign items to project collection' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async assignItemsToCollection(
    @CurrentUser('id') userId: string,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Param('collectionId') collectionId: string,
    @Body() dto: AssignItemsToCollectionDto,
  ) {
    return this.executeAssignItemsToCollection(
      userId,
      collectionId,
      dto,
      projectId,
    );
  }

  @Delete(':collectionId/items/:itemId')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Detach item from project collection' })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async detachItemFromCollection(
    @CurrentUser('id') userId: string,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Param('collectionId') collectionId: string,
    @Param('itemId') itemId: string,
  ) {
    return this.executeDetachItemFromCollection(
      userId,
      collectionId,
      itemId,
      projectId,
    );
  }

  @Post(':collectionId/items/bulk-detach')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({
    summary: 'Detach multiple items from project collection in batch',
  })
  @ApiParam({ name: 'projectId', type: 'string', format: 'uuid' })
  async bulkDetachItems(
    @CurrentUser('id') userId: string,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Param('collectionId') collectionId: string,
    @Body() dto: BulkDetachItemsDto,
  ) {
    return this.executeBulkDetachItems(userId, collectionId, dto, projectId);
  }
}
