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
import { CollectionService } from './collection.service';
import {
  CreateCollectionDto,
  UpdateCollectionDto,
  MovePapersDto,
  ReorderCollectionsDto,
} from './dto/collection.dto';
import { JwtAuthGuard, CurrentUser } from '@/modules/iam/authentication';
import {
  WorkspaceRoleGuard,
  WorkspaceRoles,
} from '@/modules/iam/authorization';

@ApiTags('Library Collections')
@ApiBearerAuth('JWT-auth')
@Controller('api/library')
@UseGuards(JwtAuthGuard)
export class CollectionController {
  constructor(private readonly collectionService: CollectionService) {}

  @Get(['collections/:workspaceId', ':workspaceId/collections'])
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({ summary: 'Get all paper collections in workspace' })
  async getCollections(@Param('workspaceId') workspaceId: string) {
    return this.collectionService.getCollections(workspaceId);
  }

  @Post(['collections/:workspaceId', ':workspaceId/collections'])
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  @ApiOperation({ summary: 'Create a new paper collection' })
  async createCollection(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateCollectionDto,
  ) {
    return this.collectionService.createCollection(workspaceId, userId, dto);
  }

  @Get([
    'collections/:workspaceId/:collectionId',
    ':workspaceId/collections/:collectionId',
  ])
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({ summary: 'Get collection details by ID' })
  async getCollectionById(@Param('collectionId') collectionId: string) {
    return this.collectionService.getCollectionById(collectionId);
  }

  @Put([
    'collections/:workspaceId/:collectionId',
    ':workspaceId/collections/:collectionId',
  ])
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  @ApiOperation({ summary: 'Update collection details' })
  async updateCollection(
    @Param('collectionId') collectionId: string,
    @Body() dto: UpdateCollectionDto,
  ) {
    return this.collectionService.updateCollection(collectionId, dto);
  }

  @Delete([
    'collections/:workspaceId/:collectionId',
    ':workspaceId/collections/:collectionId',
  ])
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  @ApiOperation({ summary: 'Delete collection' })
  async deleteCollection(
    @Param('collectionId') collectionId: string,
    @Query('strategy') strategy?: 'cascade' | 'move-to-parent' | 'orphan',
  ) {
    return this.collectionService.deleteCollection(collectionId, strategy);
  }

  @Post([
    'collections/:workspaceId/:collectionId/move-papers',
    ':workspaceId/collections/:collectionId/move-papers',
  ])
  @HttpCode(HttpStatus.OK)
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  @ApiOperation({ summary: 'Bulk move papers to a collection or unfile them' })
  async movePapers(
    @Param('workspaceId') workspaceId: string,
    @Param('collectionId') collectionId: string,
    @Body() dto: MovePapersDto,
  ) {
    return this.collectionService.movePapers(
      workspaceId,
      collectionId,
      dto.paperIds,
    );
  }

  @Patch([
    'collections/:workspaceId/reorder',
    ':workspaceId/collections/reorder',
  ])
  @HttpCode(HttpStatus.OK)
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  @ApiOperation({ summary: 'Reorder or reparent collections in hierarchy' })
  async reorderCollections(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: ReorderCollectionsDto,
  ) {
    return this.collectionService.reorderCollections(
      workspaceId,
      dto.collections,
    );
  }
}
