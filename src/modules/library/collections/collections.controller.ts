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
  MovePapersDto,
  ReorderCollectionsDto,
  AssignPapersToCollectionDto,
} from './dto/collections.dto';

import { JwtAuthGuard, CurrentUser } from '@/modules/iam/authentication';
import {
  WorkspaceRoleGuard,
  WorkspaceRoles,
} from '@/modules/iam/authorization';

@ApiTags('Library Collections')
@ApiBearerAuth('JWT-auth')
@Controller('api/library')
@UseGuards(JwtAuthGuard)
export class CollectionsController {
  constructor(private readonly CollectionsService: CollectionsService) {}

  @Get(['collections/:workspaceId', ':workspaceId/collections'])
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({ summary: 'Get all paper collections in workspace' })
  async getCollections(@Param('workspaceId') workspaceId: string) {
    return this.CollectionsService.getCollections(workspaceId);
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
    return this.CollectionsService.createCollection(workspaceId, userId, dto);
  }

  @Get([
    'collections/:workspaceId/:collectionId',
    ':workspaceId/collections/:collectionId',
  ])
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({ summary: 'Get collection details by ID' })
  async getCollectionById(@Param('collectionId') collectionId: string) {
    return this.CollectionsService.getCollectionById(collectionId);
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
    return this.CollectionsService.updateCollection(collectionId, dto);
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
    return this.CollectionsService.deleteCollection(collectionId, strategy);
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
    return this.CollectionsService.movePapers(
      workspaceId,
      collectionId,
      dto.itemIds || dto.paperIds || [],
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
    return this.CollectionsService.reorderCollections(
      workspaceId,
      dto.collections,
    );
  }

  @Post([
    'collections/:workspaceId/:collectionId/papers',
    ':workspaceId/collections/:collectionId/papers',
  ])
  @HttpCode(HttpStatus.OK)
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  @ApiOperation({ summary: 'Link papers from library to a collection' })
  async assignPapersToCollection(
    @Param('workspaceId') workspaceId: string,
    @Param('collectionId') collectionId: string,
    @Body() dto: AssignPapersToCollectionDto,
  ) {
    return this.CollectionsService.assignPapersToCollection(
      workspaceId,
      collectionId,
      dto,
    );
  }

  @Delete([
    'collections/:workspaceId/:collectionId/papers/:paperId',
    ':workspaceId/collections/:collectionId/papers/:paperId',
  ])
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  @ApiOperation({
    summary: 'Soft-detach paper from collection (preserves paper in library)',
  })
  async detachPaperFromCollection(
    @Param('workspaceId') workspaceId: string,
    @Param('collectionId') collectionId: string,
    @Param('paperId') paperId: string,
  ) {
    return this.CollectionsService.detachPaperFromCollection(
      workspaceId,
      collectionId,
      paperId,
    );
  }

  @Get([
    'collections/:workspaceId/:collectionId/bibtex',
    ':workspaceId/collections/:collectionId/bibtex',
  ])
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({
    summary: 'Export all references in a collection to BibTeX format',
  })
  async exportCollectionBibtex(
    @Param('workspaceId') workspaceId: string,
    @Param('collectionId') collectionId: string,
  ) {
    return this.CollectionsService.exportCollectionBibtex(
      workspaceId,
      collectionId,
    );
  }

  @Get([
    'collections/:workspaceId/:collectionId/export-bundle',
    ':workspaceId/collections/:collectionId/export-bundle',
  ])
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({
    summary:
      'Export complete collection archive bundle (BibTeX + PDF files manifest)',
  })
  async exportCollectionBundle(
    @Param('workspaceId') workspaceId: string,
    @Param('collectionId') collectionId: string,
  ) {
    return this.CollectionsService.getCollectionExportBundle(
      workspaceId,
      collectionId,
    );
  }
}
