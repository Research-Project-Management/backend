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
  Optional,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { CollectionsService } from '../application/services/collections.service';
import { GetCollectionsUseCase } from '../application/queries/get-collections.use-case';
import { GetCollectionTreeUseCase } from '../application/queries/get-collection-tree.use-case';
import { GetCollectionByIdUseCase } from '../application/queries/get-collection-by-id.use-case';
import { CreateCollectionUseCase } from '../application/commands/create-collection.use-case';
import { UpdateCollectionUseCase } from '../application/commands/update-collection.use-case';
import { DeleteCollectionUseCase } from '../application/commands/delete-collection.use-case';
import { ReorderCollectionsUseCase } from '../application/commands/reorder-collections.use-case';
import { MoveItemsToCollectionUseCase } from '../application/commands/move-items-to-collection.use-case';
import { AssignItemsToCollectionUseCase } from '../application/commands/assign-items-to-collection.use-case';
import { DetachItemFromCollectionUseCase } from '../application/commands/detach-item-from-collection.use-case';
import {
  CreateCollectionDto,
  UpdateCollectionDto,
  MoveItemsDto,
  ReorderCollectionsDto,
  AssignItemsToCollectionDto,
} from '../application/dtos/collections.dto';
import { CollectionDeleteStrategy } from '../domain/types/collections.types';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import { isUUID } from 'class-validator';
import { ProjectRoleGuard, ProjectRoles } from '@/modules/project/access';

const toValidProjectId = (val?: string): string | undefined =>
  val && val !== 'me' && val !== 'user' && val !== 'personal' && isUUID(val)
    ? val
    : undefined;

@ApiTags('Library Collections')
@ApiBearerAuth('JWT-auth')
@Controller([
  'api/v1/library/collections',
  'api/v1/projects/:projectId/library/collections',
])
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class CollectionsController {
  constructor(
    @Optional() private readonly collectionsService?: CollectionsService,
    @Optional()
    private readonly getCollectionsUseCase?: GetCollectionsUseCase,
    @Optional()
    private readonly getCollectionTreeUseCase?: GetCollectionTreeUseCase,
    @Optional()
    private readonly getCollectionByIdUseCase?: GetCollectionByIdUseCase,
    @Optional()
    private readonly createCollectionUseCase?: CreateCollectionUseCase,
    @Optional()
    private readonly updateCollectionUseCase?: UpdateCollectionUseCase,
    @Optional()
    private readonly deleteCollectionUseCase?: DeleteCollectionUseCase,
    @Optional()
    private readonly reorderCollectionsUseCase?: ReorderCollectionsUseCase,
    @Optional()
    private readonly moveItemsUseCase?: MoveItemsToCollectionUseCase,
    @Optional()
    private readonly assignItemsUseCase?: AssignItemsToCollectionUseCase,
    @Optional()
    private readonly detachItemUseCase?: DetachItemFromCollectionUseCase,
  ) {}

  @Get()
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'List all collections for user or project' })
  async getCollections(
    @CurrentUser('id') userId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = toValidProjectId(
      paramProjectId || queryProjectId,
    );
    if (this.getCollectionsUseCase) {
      return this.getCollectionsUseCase.execute({
        userId,
        projectId: effectiveProjectId,
      });
    }
    return this.collectionsService!.getCollections(userId, effectiveProjectId);
  }

  @Get('tree')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get collection tree for user or project' })
  async getCollectionTree(
    @CurrentUser('id') userId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = toValidProjectId(
      paramProjectId || queryProjectId,
    );
    if (this.getCollectionTreeUseCase) {
      return this.getCollectionTreeUseCase.execute({
        userId,
        projectId: effectiveProjectId,
      });
    }
    return this.collectionsService!.getCollectionTree(
      userId,
      effectiveProjectId,
    );
  }

  @Patch('reorder')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reorder collections' })
  async reorderCollections(
    @CurrentUser('id') userId: string,
    @Body() dto: ReorderCollectionsDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = paramProjectId || queryProjectId;
    if (this.reorderCollectionsUseCase) {
      return this.reorderCollectionsUseCase.execute({
        userId,
        collections: dto.collections,
        projectId: effectiveProjectId,
      });
    }
    return this.collectionsService!.reorderCollections(
      userId,
      dto.collections,
      effectiveProjectId,
    );
  }

  @Post()
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create collection' })
  async createCollection(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateCollectionDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const rawProjectId = paramProjectId || queryProjectId || dto.projectId;
    if (rawProjectId && !isUUID(rawProjectId)) {
      throw new BadRequestException('Invalid project ID');
    }
    const effectiveProjectId = toValidProjectId(rawProjectId || undefined);
    return this.collectionsService!.createCollection(
      userId,
      dto,
      effectiveProjectId || undefined,
    );
  }

  @Get(':collectionId')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get collection by ID' })
  async getCollectionById(
    @CurrentUser('id') userId: string,
    @Param('collectionId') collectionId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const rawProjectId = paramProjectId || queryProjectId;
    if (rawProjectId && !isUUID(rawProjectId)) {
      throw new BadRequestException('Invalid project ID');
    }
    const effectiveProjectId = rawProjectId;
    if (this.getCollectionByIdUseCase) {
      return this.getCollectionByIdUseCase.execute({
        userId,
        collectionId,
        projectId: effectiveProjectId,
      });
    }
    return this.collectionsService!.getCollectionById(
      userId,
      collectionId,
      effectiveProjectId,
    );
  }

  @Put(':collectionId')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Update collection' })
  async updateCollection(
    @CurrentUser('id') userId: string,
    @Param('collectionId') collectionId: string,
    @Body() dto: UpdateCollectionDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = paramProjectId || queryProjectId;
    if (this.updateCollectionUseCase) {
      return this.updateCollectionUseCase.execute({
        userId,
        collectionId,
        dto,
        projectId: effectiveProjectId,
      });
    }
    return this.collectionsService!.updateCollection(
      userId,
      collectionId,
      dto,
      effectiveProjectId,
    );
  }

  @Delete(':collectionId')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Delete collection' })
  async deleteCollection(
    @CurrentUser('id') userId: string,
    @Param('collectionId') collectionId: string,
    @Query('strategy') strategy?: CollectionDeleteStrategy,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = paramProjectId || queryProjectId;
    if (this.deleteCollectionUseCase) {
      return this.deleteCollectionUseCase.execute({
        userId,
        collectionId,
        strategy,
        projectId: effectiveProjectId,
      });
    }
    return this.collectionsService!.deleteCollection(
      userId,
      collectionId,
      strategy,
      effectiveProjectId,
    );
  }

  @Post(':collectionId/move-items')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Move items to collection' })
  async moveItems(
    @CurrentUser('id') userId: string,
    @Param('collectionId') collectionId: string,
    @Body() dto: MoveItemsDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = paramProjectId || queryProjectId;
    if (this.moveItemsUseCase) {
      return this.moveItemsUseCase.execute({
        userId,
        collectionId,
        itemIds: dto.itemIds || dto.paperIds || [],
        projectId: effectiveProjectId,
      });
    }
    return this.collectionsService!.moveItems(
      userId,
      collectionId,
      dto.itemIds || dto.paperIds || [],
      effectiveProjectId,
    );
  }

  @Post(':collectionId/items')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Assign items to collection' })
  async assignItemsToCollection(
    @CurrentUser('id') userId: string,
    @Param('collectionId') collectionId: string,
    @Body() dto: AssignItemsToCollectionDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = paramProjectId || queryProjectId;
    if (this.assignItemsUseCase) {
      return this.assignItemsUseCase.execute({
        userId,
        collectionId,
        dto,
        projectId: effectiveProjectId,
      });
    }
    return this.collectionsService!.assignItemsToCollection(
      userId,
      collectionId,
      dto,
      effectiveProjectId,
    );
  }

  @Delete(':collectionId/items/:itemId')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Detach item from collection' })
  async detachItemFromCollection(
    @CurrentUser('id') userId: string,
    @Param('collectionId') collectionId: string,
    @Param('itemId') itemId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = paramProjectId || queryProjectId;
    if (this.detachItemUseCase) {
      return this.detachItemUseCase.execute({
        userId,
        collectionId,
        itemId,
        projectId: effectiveProjectId,
      });
    }
    return this.collectionsService!.detachItemFromCollection(
      userId,
      collectionId,
      itemId,
      effectiveProjectId,
    );
  }
}
