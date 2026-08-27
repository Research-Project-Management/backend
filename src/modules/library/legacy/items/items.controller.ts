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
import { CatalogService } from './items.service';
import {
  IngestPaperDto,
  UploadPaperDto,
  AddAttachmentDto,
  UpdatePaperDto,
  ImportStoragePaperDto,
} from './dto/items.dto';

import { JwtAuthGuard } from '@/modules/iam/authn/guards/jwt-auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/current-user.decorator';
import { WorkspaceRoleGuard } from '@/modules/iam/authz/guards/workspace-role.guard';
import { WorkspaceRoles } from '@/modules/iam/authz/decorators/workspace-roles.decorator';

@ApiTags('Library Items')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard)
export class ItemsController {
  constructor(private readonly catalogService: CatalogService) {}

  // ─── Ingest ────────────────────────────────────────────────────────────────

  @Post([
    'workspace/:workspaceId/library/items/ingest',
    'library/papers/:workspaceId/ingest', // legacy prefix — used by frontend
    'library/:workspaceId/items/ingest', // legacy REST
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

  // ─── List items ────────────────────────────────────────────────────────────

  @Get([
    'workspace/:workspaceId/library/items',
    'library/papers/:workspaceId', // legacy prefix — used by frontend
    'library/:workspaceId/items', // legacy REST
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

  // ─── Tags ──────────────────────────────────────────────────────────────────

  @Get([
    'workspace/:workspaceId/library/items/tags',
    'library/papers/:workspaceId/tags', // legacy prefix — used by frontend
    'library/:workspaceId/items/tags', // legacy REST
  ])
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({
    summary: 'Get all distinct labels/tags used across workspace library items',
  })
  async getWorkspaceTags(@Param('workspaceId') workspaceId: string) {
    return this.catalogService.getWorkspaceTags(workspaceId);
  }

  // ─── Collection items ──────────────────────────────────────────────────────

  @Get([
    'workspace/:workspaceId/library/collections/:collectionId/items',
    'library/:workspaceId/collections/:collectionId/items',
  ])
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({ summary: 'Get collection library items' })
  async getCollectionItems(
    @Param('workspaceId') workspaceId: string,
    @Param('collectionId') collectionId: string,
    @Query('search') search?: string,
  ) {
    return this.catalogService.getPapers(workspaceId, {
      collectionId,
      search,
    });
  }

  // ─── Upload ────────────────────────────────────────────────────────────────

  @Post([
    'workspace/:workspaceId/library/items/upload',
    'library/papers/:workspaceId/upload', // legacy prefix — used by frontend
    'library/:workspaceId/items/upload', // legacy REST
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
    'workspace/:workspaceId/library/collections/:collectionId/upload',
    'library/papers/:workspaceId/collections/:collectionId/upload', // legacy
    'library/:workspaceId/collections/:collectionId/upload', // legacy REST
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

  // ─── Import from Storage ───────────────────────────────────────────────────

  @Post([
    'workspace/:workspaceId/library/items/import-storage',
    'library/papers/:workspaceId/import-storage', // legacy prefix — used by frontend
    'library/:workspaceId/items/import-storage', // legacy REST
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

  // ─── Single item CRUD ──────────────────────────────────────────────────────

  @Get([
    'workspace/:workspaceId/library/items/:itemId',
    'library/papers/:workspaceId/:itemId', // legacy prefix — used by frontend
    'library/:workspaceId/items/:itemId', // legacy REST
  ])
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({ summary: 'Get library item by ID' })
  async getItemById(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
  ) {
    return this.catalogService.getItemByIdInWorkspace(workspaceId, itemId);
  }

  @Put([
    'workspace/:workspaceId/library/items/:itemId',
    'library/papers/:workspaceId/:itemId', // legacy prefix — used by frontend
    'library/:workspaceId/items/:itemId', // legacy REST
  ])
  @Patch([
    'workspace/:workspaceId/library/items/:itemId',
    'library/papers/:workspaceId/:itemId',
    'library/:workspaceId/items/:itemId',
  ])
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  @ApiOperation({ summary: 'Update library item metadata' })
  async updateItem(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
    @Body() dto: UpdatePaperDto,
  ) {
    return this.catalogService.updateItemInWorkspace(workspaceId, itemId, dto);
  }

  @Delete([
    'workspace/:workspaceId/library/items/:itemId',
    'library/papers/:workspaceId/:itemId', // legacy prefix — used by frontend
    'library/:workspaceId/items/:itemId', // legacy REST
  ])
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  @ApiOperation({ summary: 'Delete library item (soft delete)' })
  async deleteItem(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
  ) {
    return this.catalogService.deleteItemInWorkspace(workspaceId, itemId);
  }

  @Post([
    'workspace/:workspaceId/library/items/:itemId/restore',
    'library/papers/:workspaceId/:itemId/restore',
    'library/:workspaceId/items/:itemId/restore',
  ])
  @HttpCode(HttpStatus.OK)
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  @ApiOperation({ summary: 'Restore a soft-deleted catalog item' })
  async restoreItem(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
  ) {
    return this.catalogService.restoreItemInWorkspace(workspaceId, itemId);
  }

  @Delete([
    'workspace/:workspaceId/library/items/:itemId/purge',
    'library/papers/:workspaceId/:itemId/purge',
    'library/:workspaceId/items/:itemId/purge',
  ])
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin')
  @ApiOperation({ summary: 'Permanently purge a catalog item from workspace' })
  async purgeItem(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
  ) {
    return this.catalogService.purgeItemInWorkspace(workspaceId, itemId);
  }

  // ─── Attachments ───────────────────────────────────────────────────────────

  @Post([
    'workspace/:workspaceId/library/items/:itemId/attachments',
    'library/papers/:workspaceId/:itemId/attachments', // legacy
    'library/:workspaceId/items/:itemId/attachments', // legacy REST
  ])
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  @ApiOperation({ summary: 'Add library item attachment' })
  async addAttachment(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
    @Body() dto: AddAttachmentDto,
  ) {
    return this.catalogService.addAttachmentInWorkspace(
      workspaceId,
      itemId,
      dto,
    );
  }

  @Delete([
    'workspace/:workspaceId/library/items/:itemId/attachments/:attachmentId',
    'library/papers/:workspaceId/:itemId/attachments/:attachmentId', // legacy
    'library/:workspaceId/items/:itemId/attachments/:attachmentId', // legacy REST
  ])
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  @ApiOperation({ summary: 'Remove library item attachment' })
  async removeAttachment(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
    @Param('attachmentId') attachmentId: string,
  ) {
    return this.catalogService.removeAttachmentInWorkspace(
      workspaceId,
      itemId,
      attachmentId,
    );
  }

  // ─── Reindex ───────────────────────────────────────────────────────────────

  @Post([
    'workspace/:workspaceId/library/items/:itemId/reindex',
    'library/papers/:workspaceId/:itemId/reindex', // legacy
    'library/:workspaceId/items/:itemId/reindex', // legacy REST
  ])
  @HttpCode(HttpStatus.OK)
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member')
  @ApiOperation({
    summary: 'Trigger library item reindexing for search and AI',
  })
  async triggerReindex(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.catalogService.triggerReindexInWorkspace(
      workspaceId,
      itemId,
      userId,
    );
  }
}

export { ItemsController as CatalogController };
