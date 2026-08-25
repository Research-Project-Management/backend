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

import { JwtAuthGuard, CurrentUser } from '@/modules/iam/authn';
import {
  WorkspaceRoleGuard,
  WorkspaceRoles,
} from '@/modules/iam/authz';

@ApiTags('Library Collections')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard)
export class CollectionsController {
  constructor(private readonly CollectionsService: CollectionsService) {}

  @Get([
    'workspace/:workspaceId/library/collections',
    'library/collections/:workspaceId',
    'library/:workspaceId/collections',
  ])
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({ summary: 'Get all paper collections in workspace' })
  async getCollections(@Param('workspaceId') workspaceId: string) {
    return this.CollectionsService.getCollections(workspaceId);
  }

  @Post([
    'workspace/:workspaceId/library/collections',
    'library/collections/:workspaceId',
    'library/:workspaceId/collections',
  ])
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
    return this.CollectionsService.getCollectionById(
      workspaceId,
      collectionId,
    );
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
    return this.CollectionsService.updateCollection(
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
    @Query('strategy') strategy?: 'cascade' | 'move-to-parent' | 'orphan',
  ) {
    return this.CollectionsService.deleteCollection(
      workspaceId,
      collectionId,
      strategy,
    );
  }

  @Post([
    'workspace/:workspaceId/library/collections/:collectionId/move-papers',
    'library/collections/:workspaceId/:collectionId/move-papers',
    'library/:workspaceId/collections/:collectionId/move-papers',
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
    return this.CollectionsService.reorderCollections(
      workspaceId,
      dto.collections,
    );
  }

  @Post([
    'workspace/:workspaceId/library/collections/:collectionId/papers',
    'library/collections/:workspaceId/:collectionId/papers',
    'library/:workspaceId/collections/:collectionId/papers',
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
    'workspace/:workspaceId/library/collections/:collectionId/papers/:paperId',
    'library/collections/:workspaceId/:collectionId/papers/:paperId',
    'library/:workspaceId/collections/:collectionId/papers/:paperId',
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
    'workspace/:workspaceId/library/collections/:collectionId/bibtex',
    'library/collections/:workspaceId/:collectionId/bibtex',
    'library/:workspaceId/collections/:collectionId/bibtex',
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
    'workspace/:workspaceId/library/collections/:collectionId/export-bundle',
    'library/collections/:workspaceId/:collectionId/export-bundle',
    'library/:workspaceId/collections/:collectionId/export-bundle',
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
