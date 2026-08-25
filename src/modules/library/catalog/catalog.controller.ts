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
import { CatalogService } from './catalog.service';
import {
  IngestPaperDto,
  UploadPaperDto,
  AddAttachmentDto,
  UpdatePaperDto,
  ImportStoragePaperDto,
} from './dto/catalog.dto';

import { JwtAuthGuard, CurrentUser } from '@/modules/iam/authentication';
import {
  WorkspaceRoleGuard,
  WorkspaceRoles,
} from '@/modules/iam/authorization';

@ApiTags('Library Catalog')
@ApiBearerAuth('JWT-auth')
@Controller('api/library')
@UseGuards(JwtAuthGuard)
export class CatalogController {
  constructor(private readonly catalogService: CatalogService) {}

  private getRouteItemId(params: {
    itemId?: string;
    paperId?: string;
  }): string {
    return params.itemId ?? params.paperId ?? '';
  }

  @Post([
    'papers/:workspaceId/ingest',
    'items/:workspaceId/ingest',
    ':workspaceId/ingest',
  ])
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  @ApiOperation({ summary: 'Ingest research item into workspace library' })
  async ingestPaper(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: IngestPaperDto,
  ) {
    return this.catalogService.ingestPaper(workspaceId, userId, dto);
  }

  @Get([
    'papers/:workspaceId',
    'items/:workspaceId',
    ':workspaceId/papers',
    ':workspaceId/items',
  ])
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({
    summary:
      'Get workspace library items with optional search, collection, and smart filters (unfiled, missing-doi, missing-pdf, with-notes)',
  })
  async getPapers(
    @Param('workspaceId') workspaceId: string,
    @Query('collectionId') collectionId?: string,
    @Query('search') search?: string,
    @Query('smartFilter') smartFilter?: string,
    @Query('limit') limit?: number,
    @Query('skip') skip?: number,
  ) {
    return this.catalogService.getPapers(workspaceId, {
      collectionId,
      search,
      smartFilter,
      limit,
      skip,
    });
  }

  @Get([
    'papers/:workspaceId/tags',
    'items/:workspaceId/tags',
    ':workspaceId/tags',
  ])
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({
    summary: 'Get all distinct labels/tags used across workspace library items',
  })
  async getWorkspaceTags(@Param('workspaceId') workspaceId: string) {
    return this.catalogService.getWorkspaceTags(workspaceId);
  }

  @Get([
    ':workspaceId/collections/:collectionId/papers',
    ':workspaceId/collections/:collectionId/items',
  ])
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({ summary: 'Get collection library items' })
  async getCollectionPapers(
    @Param('workspaceId') workspaceId: string,
    @Param('collectionId') collectionId: string,
    @Query('search') search?: string,
  ) {
    return this.catalogService.getPapers(workspaceId, {
      collectionId,
      search,
    });
  }

  @Post([
    'papers/:workspaceId/upload',
    'items/:workspaceId/upload',
    ':workspaceId/papers/upload',
    ':workspaceId/items/upload',
    ':workspaceId/upload',
  ])
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  @ApiOperation({ summary: 'Upload research item PDF' })
  async uploadPaper(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: UploadPaperDto,
  ) {
    return this.catalogService.uploadPaper(workspaceId, userId, dto);
  }

  @Post([
    'papers/:workspaceId/collections/:collectionId/upload',
    'items/:workspaceId/collections/:collectionId/upload',
    ':workspaceId/collections/:collectionId/upload',
  ])
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  @ApiOperation({ summary: 'Upload library item to specific collection' })
  async uploadPaperToCollection(
    @Param('workspaceId') workspaceId: string,
    @Param('collectionId') collectionId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: UploadPaperDto,
  ) {
    dto.collectionId = collectionId;
    return this.catalogService.uploadPaper(workspaceId, userId, dto);
  }

  @Post([
    'papers/:workspaceId/import-storage',
    'items/:workspaceId/import-storage',
    ':workspaceId/papers/import-storage',
    ':workspaceId/items/import-storage',
    ':workspaceId/import-storage',
  ])
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  @ApiOperation({ summary: 'Import library item from storage file' })
  async importFromStorage(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: ImportStoragePaperDto,
  ) {
    return this.catalogService.importFromStorage(workspaceId, userId, dto);
  }

  @Get([
    'papers/:workspaceId/:paperId',
    'items/:workspaceId/:itemId',
    ':workspaceId/papers/:paperId',
    ':workspaceId/items/:itemId',
  ])
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({ summary: 'Get library item by ID' })
  async getPaperById(
    @Param() params: { workspaceId: string; itemId?: string; paperId?: string },
  ) {
    return this.catalogService.getItemByIdInWorkspace(
      params.workspaceId,
      this.getRouteItemId(params),
    );
  }

  @Post([
    'papers/:workspaceId/:paperId/attachments',
    'items/:workspaceId/:itemId/attachments',
    ':workspaceId/papers/:paperId/attachments',
    ':workspaceId/items/:itemId/attachments',
  ])
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  @ApiOperation({ summary: 'Add library item attachment' })
  async addAttachment(
    @Param() params: { workspaceId: string; itemId?: string; paperId?: string },
    @Body() dto: AddAttachmentDto,
  ) {
    return this.catalogService.addAttachmentInWorkspace(
      params.workspaceId,
      this.getRouteItemId(params),
      dto,
    );
  }

  @Delete([
    'papers/:workspaceId/:paperId/attachments/:attachmentId',
    'items/:workspaceId/:itemId/attachments/:attachmentId',
    ':workspaceId/papers/:paperId/attachments/:attachmentId',
    ':workspaceId/items/:itemId/attachments/:attachmentId',
  ])
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  @ApiOperation({ summary: 'Remove library item attachment' })
  async removeAttachment(
    @Param() params: { workspaceId: string; itemId?: string; paperId?: string },
    @Param('attachmentId') attachmentId: string,
  ) {
    return this.catalogService.removeAttachmentInWorkspace(
      params.workspaceId,
      this.getRouteItemId(params),
      attachmentId,
    );
  }

  @Post([
    'papers/:workspaceId/:paperId/reindex',
    'items/:workspaceId/:itemId/reindex',
    ':workspaceId/papers/:paperId/reindex',
    ':workspaceId/items/:itemId/reindex',
  ])
  @HttpCode(HttpStatus.OK)
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  @ApiOperation({
    summary: 'Trigger library item reindexing for search and AI',
  })
  async triggerReindex(
    @Param() params: { workspaceId: string; itemId?: string; paperId?: string },
    @CurrentUser('id') userId: string,
  ) {
    return this.catalogService.triggerReindexInWorkspace(
      params.workspaceId,
      this.getRouteItemId(params),
      userId,
    );
  }

  @Put([
    'papers/:workspaceId/:paperId',
    'items/:workspaceId/:itemId',
    ':workspaceId/papers/:paperId',
    ':workspaceId/items/:itemId',
  ])
  @Patch([
    'papers/:workspaceId/:paperId',
    'items/:workspaceId/:itemId',
    ':workspaceId/papers/:paperId',
    ':workspaceId/items/:itemId',
  ])
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  @ApiOperation({ summary: 'Update library item metadata' })
  async updateItem(
    @Param() params: { workspaceId: string; itemId?: string; paperId?: string },
    @Body() dto: UpdatePaperDto,
  ) {
    return this.catalogService.updateItemInWorkspace(
      params.workspaceId,
      this.getRouteItemId(params),
      dto,
    );
  }

  @Delete([
    'papers/:workspaceId/:paperId',
    'items/:workspaceId/:itemId',
    ':workspaceId/papers/:paperId',
    ':workspaceId/items/:itemId',
  ])
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  @ApiOperation({ summary: 'Delete library item' })
  async deleteItem(
    @Param() params: { workspaceId: string; itemId?: string; paperId?: string },
  ) {
    return this.catalogService.deleteItemInWorkspace(
      params.workspaceId,
      this.getRouteItemId(params),
    );
  }

  @Get([
    'papers/:workspaceId/:paperId/bibtex',
    'items/:workspaceId/:itemId/bibtex',
  ])
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({ summary: 'Export library item BibTeX' })
  async exportBibtex(
    @Param() params: { workspaceId: string; itemId?: string; paperId?: string },
  ) {
    return this.catalogService.exportBibtexInWorkspace(
      params.workspaceId,
      this.getRouteItemId(params),
    );
  }
}
