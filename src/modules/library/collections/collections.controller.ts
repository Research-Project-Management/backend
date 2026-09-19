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
import { JwtAuthGuard } from '../../../modules/iam/authn/guards/auth.guard';
import { CurrentUser } from '../../../modules/iam/authn/decorators/user.decorator';
import { ProjectRoleGuard } from '../../../modules/iam/authz/guards/role.guard';
import { ProjectRoles } from '../../../modules/iam/authz/decorators/role.decorator';
import { isUUID } from 'class-validator';

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
  constructor(private readonly collectionsService: CollectionsService) {}

  @Get()
  @ProjectRoles('owner', 'contributor', 'viewer')
  @ApiOperation({ summary: 'List all collections for user or project' })
  async getCollections(
    @CurrentUser('id') userId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = toValidProjectId(paramProjectId || queryProjectId);
    return this.collectionsService.getCollections(userId, effectiveProjectId);
  }

  @Get('tree')
  @ProjectRoles('owner', 'contributor', 'viewer')
  @ApiOperation({ summary: 'Get collection tree for user or project' })
  async getCollectionTree(
    @CurrentUser('id') userId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = toValidProjectId(paramProjectId || queryProjectId);
    return this.collectionsService.getCollectionTree(
      userId,
      effectiveProjectId,
    );
  }

  @Patch('reorder')
  @ProjectRoles('owner', 'contributor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reorder collections' })
  async reorderCollections(
    @CurrentUser('id') userId: string,
    @Body() dto: ReorderCollectionsDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = paramProjectId || queryProjectId;
    return this.collectionsService.reorderCollections(
      userId,
      dto.collections,
      effectiveProjectId,
    );
  }

  @Post()
  @ProjectRoles('owner', 'contributor')
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
    return this.collectionsService.createCollection(
      userId,
      dto,
      effectiveProjectId || undefined,
    );
  }

  @Get(':collectionId')
  @ProjectRoles('owner', 'contributor', 'viewer')
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
    return this.collectionsService.getCollectionById(
      userId,
      collectionId,
      effectiveProjectId,
    );
  }

  @Put(':collectionId')
  @ProjectRoles('owner', 'contributor')
  @ApiOperation({ summary: 'Update collection' })
  async updateCollection(
    @CurrentUser('id') userId: string,
    @Param('collectionId') collectionId: string,
    @Body() dto: UpdateCollectionDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = paramProjectId || queryProjectId;
    return this.collectionsService.updateCollection(
      userId,
      collectionId,
      dto,
      effectiveProjectId,
    );
  }

  @Delete(':collectionId')
  @ProjectRoles('owner', 'contributor')
  @ApiOperation({ summary: 'Delete collection' })
  async deleteCollection(
    @CurrentUser('id') userId: string,
    @Param('collectionId') collectionId: string,
    @Query('strategy') strategy?: CollectionDeleteStrategy,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = paramProjectId || queryProjectId;
    return this.collectionsService.deleteCollection(
      userId,
      collectionId,
      strategy,
      effectiveProjectId,
    );
  }

  @Post(':collectionId/move-items')
  @ProjectRoles('owner', 'contributor')
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
    return this.collectionsService.moveItems(
      userId,
      collectionId,
      dto.itemIds || dto.paperIds || [],
      effectiveProjectId,
    );
  }

  @Post(':collectionId/items')
  @ProjectRoles('owner', 'contributor')
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
    return this.collectionsService.assignItemsToCollection(
      userId,
      collectionId,
      dto,
      effectiveProjectId,
    );
  }

  @Delete(':collectionId/items/:itemId')
  @ProjectRoles('owner', 'contributor')
  @ApiOperation({ summary: 'Detach item from collection' })
  async detachItemFromCollection(
    @CurrentUser('id') userId: string,
    @Param('collectionId') collectionId: string,
    @Param('itemId') itemId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = paramProjectId || queryProjectId;
    return this.collectionsService.detachItemFromCollection(
      userId,
      collectionId,
      itemId,
      effectiveProjectId,
    );
  }
}
