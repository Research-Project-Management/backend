import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '@/modules/identity/auth';
import { CurrentUser } from '@/modules/identity/auth';
import {
  DriveService,
  TrashService,
  QuotaService,
} from '../services/drive.service';
import { StorageNode, FileScope } from '@/modules/storage/drive';
import { getFileContentPath } from '@/modules/storage/storage.port';
import { StorageAccessPolicy } from '../services/access.policy';
import {
  CreateFolderDto,
  MoveFileDto,
  RenameFileDto,
  ShareFileDto,
  BatchFileIdsDto,
  BatchStarDto,
} from '../dto/drive.dto';

function formatBytes(bytes: number, decimals = 1): string {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

interface PaginationParams {
  take: number;
  skip: number;
  currentPage: number;
}

function parsePagination(
  limit?: number,
  offset?: number,
  page?: number,
): PaginationParams {
  const take = limit ? Number(limit) : 100;
  const skip =
    offset !== undefined
      ? Number(offset)
      : page
        ? (Number(page) - 1) * take
        : 0;
  const currentPage = page ? Number(page) : Math.floor(skip / take) + 1;
  return { take, skip, currentPage };
}

function buildPaginatedDriveResponse(
  result: { nodes: StorageNode[]; total: number },
  pagination: PaginationParams,
) {
  const files = (result.nodes || []).map((node) => mapStorageNodeToDto(node));
  return {
    files,
    items: files,
    total: result.total,
    page: pagination.currentPage,
    limit: pagination.take,
    hasMore: pagination.skip + files.length < result.total,
  };
}

export function mapStorageNodeToDto(node: StorageNode) {
  const metadataAuthor =
    node.metadata?.author && typeof node.metadata.author === 'object'
      ? (node.metadata.author as {
          name?: string;
          email?: string;
          avatar?: string;
        })
      : null;

  return {
    id: node.id,
    filename: node.name,
    name: node.name,
    size: Number(node.size),
    mimeType: node.mimeType,
    isFolder: node.isFolder,
    starred: node.starred,
    isStarred: node.starred,
    parentId: node.parentId,
    parent: node.parentId,
    url: getFileContentPath(node.id),
    thumbnail:
      typeof node.metadata?.thumbnail === 'string'
        ? node.metadata.thumbnail
        : null,
    metaData: node.metadata || {},
    trashedAt: node.trashedAt ? node.trashedAt.toISOString() : null,
    author: {
      id: node.author?.id || node.authorId,
      name:
        node.author?.name ||
        metadataAuthor?.name ||
        (typeof node.metadata?.authorName === 'string'
          ? node.metadata.authorName
          : '') ||
        node.author?.email ||
        '',
      email: node.author?.email || metadataAuthor?.email || '',
      avatar: node.author?.avatar || metadataAuthor?.avatar || '',
    },
    createdAt: node.createdAt
      ? node.createdAt.toISOString()
      : new Date().toISOString(),
    updatedAt: node.updatedAt
      ? node.updatedAt.toISOString()
      : new Date().toISOString(),
  };
}

@ApiTags('Storage & Drive')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/storage/files')
@UseGuards(JwtAuthGuard)
export class DriveController {
  constructor(
    private readonly driveService: DriveService,
    private readonly trashService: TrashService,
    private readonly accessPolicy: StorageAccessPolicy,
  ) {}

  private mapNodeToDto(node: StorageNode) {
    return mapStorageNodeToDto(node);
  }

  private async assertBatchAccess(
    userId: string | undefined,
    ids: string[],
    action: 'read' | 'write' | 'delete',
  ): Promise<void> {
    if (!userId) return;
    for (const id of ids) {
      await this.accessPolicy.assertCanAccess(userId, id, action);
    }
  }

  @Get('my-files')
  @ApiOperation({ summary: 'Get current user personal files and folders' })
  async getMyFiles(
    @CurrentUser('id') userId: string,
    @Query('parentId') parentId?: string,
    @Query('search') search?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: 'asc' | 'desc',
    @Query('type') type?: string,
    @Query('types') types?: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
    @Query('page') page?: number,
  ) {
    const pagination = parsePagination(limit, offset, page);
    const parsedTypes = types
      ? types
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
      : type && type !== 'all'
        ? [type]
        : undefined;

    const result = await this.driveService.list({
      userId,
      parentId:
        !parentId || parentId === 'null' || parentId === 'root'
          ? null
          : parentId,
      search: search?.trim() || undefined,
      sortBy: sortBy || undefined,
      sortOrder: sortOrder || 'asc',
      types: parsedTypes,
      limit: pagination.take,
      offset: pagination.skip,
    });
    return buildPaginatedDriveResponse(result, pagination);
  }

  @Get('shared')
  @ApiOperation({ summary: 'Get shared files' })
  async getSharedFiles(
    @CurrentUser('id') userId: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
    @Query('page') page?: number,
  ) {
    const { take, skip, currentPage } = parsePagination(limit, offset, page);

    const { items, total } = await this.driveService.listSharedWithUser(
      userId,
      take,
      skip,
    );

    const files = items.map((s) => ({
      ...this.mapNodeToDto(s.node),
      permission: s.permission,
      sharedAt: s.sharedAt.toISOString(),
    }));

    return {
      items: files,
      files,
      total,
      page: currentPage,
      limit: take,
      totalPages: Math.ceil(total / take) || 0,
      hasMore: skip + files.length < total,
    };
  }

  @Get('folder-path')
  @ApiOperation({ summary: 'Get breadcrumb path for a folder hierarchy' })
  async getFolderPath(@Query('folderId') folderId?: string) {
    const path = await this.driveService.getFolderPath(folderId);
    return { path };
  }

  @Get('pages/:pageId')
  @ApiOperation({ summary: 'List files associated with a page' })
  async getPageFiles(
    @Param('pageId') pageId: string,
    @Query('parentId') parentId?: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
    @Query('page') page?: number,
  ) {
    const pagination = parsePagination(limit, offset, page);
    const result = await this.driveService.list({
      scope: FileScope.Page,
      projectId: pageId,
      parentId: parentId || null,
      limit: pagination.take,
      offset: pagination.skip,
    });
    return buildPaginatedDriveResponse(result, pagination);
  }

  @Get('starred')
  @ApiOperation({ summary: 'Get starred files' })
  async getStarredFiles(
    @CurrentUser('id') userId: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
    @Query('page') page?: number,
  ) {
    const pagination = parsePagination(limit, offset, page);
    const result = await this.driveService.list({
      userId,
      starredOnly: true,
      limit: pagination.take,
      offset: pagination.skip,
    });
    return buildPaginatedDriveResponse(result, pagination);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get file metadata by ID' })
  async getFileById(
    @Param('id') id: string,
    @CurrentUser('id') userId?: string,
  ) {
    const node = userId
      ? await this.accessPolicy.assertCanAccess(userId, id, 'read')
      : await this.driveService.getNodeById(id);
    return this.mapNodeToDto(node);
  }

  @Put(':id/star')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Toggle star status on a file or folder' })
  async toggleStar(
    @Param('id') id: string,
    @CurrentUser('id') userId?: string,
  ) {
    if (userId) {
      await this.accessPolicy.assertCanAccess(userId, id, 'read');
    }
    const updated = await this.driveService.toggleStar(id);
    return { success: true, starred: updated.starred };
  }

  @Put(':id/share')
  @Post(':id/share')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Share a file with another user' })
  async shareFile(
    @Param('id') id: string,
    @Body() dto: ShareFileDto,
    @CurrentUser('id') currentUserId?: string,
  ) {
    if (currentUserId) {
      await this.accessPolicy.assertCanAccess(currentUserId, id, 'share');
    }
    const share = await this.driveService.shareNode(
      id,
      dto.userId,
      dto.permission,
    );
    return {
      success: true,
      share,
    };
  }

  @Post('folder')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new folder' })
  async createFolder(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateFolderDto,
  ) {
    const folderName = dto.name || dto.filename || 'New Folder';
    const created = await this.driveService.createFolder({
      userId,
      name: folderName,
      parentId: dto.parentId || null,
    });
    return this.mapNodeToDto(created);
  }

  @Post(['pages/:pageId/folder', 'projects/:projectId/folder'])
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new folder in page or project scope' })
  async createScopedFolder(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateFolderDto,
    @Param('pageId') pageId?: string,
    @Param('projectId') projectId?: string,
  ) {
    const folderName = dto.name || dto.filename || 'New Folder';
    const created = await this.driveService.createFolder({
      userId,
      name: folderName,
      projectId: projectId || null,
      parentId: dto.parentId || null,
      metadata: pageId ? { pageId } : {},
    });
    return this.mapNodeToDto(created);
  }

  @Put(':id/move')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Move a file or folder by ID' })
  async moveNodeById(
    @Param('id') id: string,
    @Body() dto: MoveFileDto,
    @CurrentUser('id') userId?: string,
  ) {
    const targetFolderId = dto.parentId ?? null;
    if (userId) {
      await this.accessPolicy.assertCanAccess(userId, id, 'write');
      if (targetFolderId) {
        await this.accessPolicy.assertCanAccess(
          userId,
          targetFolderId,
          'write',
        );
      }
    }
    const updated = await this.driveService.move(id, targetFolderId);
    return this.mapNodeToDto(updated);
  }

  @Put(':id/rename')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rename a file or folder' })
  async renameNode(
    @Param('id') id: string,
    @Body() dto: RenameFileDto,
    @CurrentUser('id') userId?: string,
  ) {
    if (userId) {
      await this.accessPolicy.assertCanAccess(userId, id, 'write');
    }
    const newName = dto.name || dto.filename;
    if (!newName) throw new NotFoundException('New name is required');
    const updated = await this.driveService.rename(id, newName);
    return this.mapNodeToDto(updated);
  }

  @Put(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update file metadata and description' })
  async updateNodeMetadata(
    @Param('id') id: string,
    @Body() dto: { metaData?: Record<string, unknown>; description?: string },
    @CurrentUser('id') userId?: string,
  ) {
    if (userId) {
      await this.accessPolicy.assertCanAccess(userId, id, 'write');
    }
    const updated = await this.driveService.updateMetadata(
      id,
      dto.metaData,
      dto.description,
    );
    return this.mapNodeToDto(updated);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Move file to trash' })
  async deleteFile(
    @Param('id') id: string,
    @CurrentUser('id') userId?: string,
  ) {
    if (userId) {
      await this.accessPolicy.assertCanAccess(userId, id, 'delete');
    }
    return this.trashService.softDelete(id);
  }

  @Post('batch/delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Batch move files to trash' })
  async batchDelete(
    @Body() dto: BatchFileIdsDto,
    @CurrentUser('id') userId?: string,
  ) {
    await this.assertBatchAccess(userId, dto.ids, 'delete');
    const count = await this.trashService.batchSoftDelete(dto.ids);
    return { success: true, count };
  }

  @Post('batch/star')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Batch star/unstar files' })
  async batchStar(
    @Body() dto: BatchStarDto,
    @CurrentUser('id') userId?: string,
  ) {
    await this.assertBatchAccess(userId, dto.ids, 'read');
    await this.driveService.batchStar(dto.ids, dto.starred);
    return { success: true };
  }

  @Post('batch/move')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Batch move multiple files or folders' })
  async batchMove(
    @Body()
    dto: {
      ids: string[];
      parentId?: string | null;
      targetFolderId?: string | null;
    },
    @CurrentUser('id') userId?: string,
  ) {
    const targetFolderId =
      dto.parentId !== undefined ? dto.parentId : (dto.targetFolderId ?? null);
    if (userId && targetFolderId) {
      await this.accessPolicy.assertCanAccess(userId, targetFolderId, 'write');
    }
    await this.assertBatchAccess(userId, dto.ids || [], 'write');
    const count = await this.driveService.batchMove(
      dto.ids || [],
      targetFolderId,
    );
    return { success: true, count };
  }
}

@ApiTags('Storage & Trash')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/storage/files')
@UseGuards(JwtAuthGuard)
export class TrashController {
  constructor(
    private readonly driveService: DriveService,
    private readonly trashService: TrashService,
    private readonly accessPolicy: StorageAccessPolicy,
  ) {}

  private async assertBatchTrashAccess(
    userId: string | undefined,
    ids: string[],
  ): Promise<void> {
    if (!userId) return;
    for (const id of ids) {
      await this.accessPolicy.assertCanAccess(userId, id, 'delete', {
        allowTrashed: true,
      });
    }
  }

  @Get('trash')
  @ApiOperation({ summary: 'List files and folders currently in trash' })
  async getTrash(
    @CurrentUser('id') userId: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
    @Query('page') page?: number,
  ) {
    const pagination = parsePagination(limit, offset, page);
    const result = await this.driveService.list({
      userId,
      trashedOnly: true,
      limit: pagination.take,
      offset: pagination.skip,
    });
    return buildPaginatedDriveResponse(result, pagination);
  }

  @Post(':id/trash')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Soft-delete file to trash' })
  async moveToTrash(
    @Param('id') id: string,
    @CurrentUser('id') userId?: string,
  ) {
    if (userId) {
      await this.accessPolicy.assertCanAccess(userId, id, 'delete');
    }
    const count = await this.trashService.softDelete(id);
    return { success: true, count };
  }

  @Post(':id/restore')
  @Put(':id/restore')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Restore file from trash' })
  async restoreFile(
    @Param('id') id: string,
    @CurrentUser('id') userId?: string,
  ) {
    if (userId) {
      await this.accessPolicy.assertCanAccess(userId, id, 'delete', {
        allowTrashed: true,
      });
    }
    const count = await this.trashService.restore(id);
    return { success: true, count };
  }

  @Delete(':id/permanent')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Permanently delete file and reclaim quota' })
  async permanentDelete(
    @Param('id') id: string,
    @CurrentUser('id') userId?: string,
  ) {
    if (userId) {
      await this.accessPolicy.assertCanAccess(userId, id, 'delete', {
        allowTrashed: true,
      });
    }
    await this.trashService.permanentDelete(id);
    return { success: true };
  }

  @Post('batch/restore')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Batch restore files from trash' })
  async batchRestore(
    @CurrentUser('id') userId: string,
    @Body() dto: BatchFileIdsDto,
  ) {
    await this.assertBatchTrashAccess(userId, dto.ids);
    const count = await this.trashService.batchRestore(dto.ids);
    return { success: true, count };
  }

  @Post('batch/permanent')
  @Delete('batch/permanent')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Batch permanently delete files from trash' })
  async batchPermanentDelete(
    @CurrentUser('id') userId: string,
    @Body() dto: BatchFileIdsDto,
  ) {
    await this.assertBatchTrashAccess(userId, dto.ids);
    const count = await this.trashService.batchPermanentDelete(dto.ids);
    return { success: true, count };
  }
}

@ApiTags('Storage & Quota')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/storage/files')
@UseGuards(JwtAuthGuard)
export class QuotaController {
  constructor(private readonly quotaService: QuotaService) {}

  @Get('usage')
  @ApiOperation({
    summary: 'Get current user or project storage usage and limit',
  })
  async getUsage(
    @CurrentUser('id') userId: string,
    @Query('projectId') projectId?: string,
  ) {
    const result = await this.quotaService.check(userId, projectId);
    return {
      ...result,
      totalBytes: result.usedBytes,
      usedBytes: result.usedBytes,
      limitBytes: result.maxBytes,
      usedFormatted: formatBytes(result.usedBytes),
      limitFormatted: formatBytes(result.maxBytes),
      scope: projectId ? 'project' : 'personal',
    };
  }
}
