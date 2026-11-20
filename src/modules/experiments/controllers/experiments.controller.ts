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
  BadRequestException,
  Inject,
  Optional,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import {
  DEFAULT_STORAGE_QUOTA_BYTES,
  FILES_PORT,
  type IFilesPort,
} from '@/modules/files';
import { ExperimentsService } from '../services/experiments.service';
import { TrashService } from '../services/trash.service';
import { FileScope, ExperimentNode } from '../domain/node.domain';
import {
  ExperimentsAccessPolicy,
  normalizeExperimentProjectId,
} from '../domain/access.policy';
import {
  buildPaginatedExperimentsResponse,
  formatBytes,
  mapExperimentNodeToDto,
  parsePagination,
  parseTypesQuery,
} from '../domain/experiments.mapper';
import {
  BatchFileIdsDto,
  BatchMoveDto,
  BatchStarDto,
  CreateFolderDto,
  MoveFileDto,
  RenameFileDto,
  ShareFileDto,
} from '../dto/experiments.dto';

@ApiTags('Experiments')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/experiments/files')
@UseGuards(JwtAuthGuard)
export class ExperimentsController {
  constructor(
    private readonly experimentsService: ExperimentsService,
    private readonly trashService: TrashService,
    private readonly accessPolicy: ExperimentsAccessPolicy,
    @Optional()
    @Inject(FILES_PORT)
    private readonly filesPort?: IFilesPort,
  ) {}

  private mapNodeToDto(node: ExperimentNode) {
    return mapExperimentNodeToDto(node);
  }

  private async assertBatchAccess(
    userId: string | undefined,
    ids: string[],
    action: 'read' | 'write' | 'delete',
  ): Promise<void> {
    if (!userId) return;
    await Promise.all(
      ids.map((id) => this.accessPolicy.assertCanAccess(userId, id, action)),
    );
  }

  @Get('my-files')
  @ApiOperation({
    summary: 'Get current user personal or project files and folders',
  })
  async getMyFiles(
    @CurrentUser('id') userId: string,
    @Query('parentId') parentId?: string,
    @Query('spaceId') spaceId?: string,
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
    const parsedTypes = parseTypesQuery(types, type);
    const normalizedParentId =
      !parentId || parentId === 'null' || parentId === 'root' ? null : parentId;
    const normalizedProjectId = normalizeExperimentProjectId(spaceId, userId);

    if (normalizedProjectId && userId) {
      await this.accessPolicy.assertCanAccessProject(
        userId,
        normalizedProjectId,
        'read',
      );
    }
    if (normalizedParentId && userId) {
      await this.accessPolicy.assertCanAccess(
        userId,
        normalizedParentId,
        'read',
      );
    }

    const result = await this.experimentsService.list({
      userId: normalizedProjectId ? undefined : userId,
      projectId: normalizedProjectId,
      scope: normalizedProjectId ? FileScope.Project : undefined,
      parentId: normalizedParentId,
      search: search?.trim() || undefined,
      sortBy: sortBy || undefined,
      sortOrder: sortOrder || 'asc',
      types: parsedTypes,
      limit: pagination.take,
      offset: pagination.skip,
    });
    return buildPaginatedExperimentsResponse(result, pagination);
  }

  @Get('shared')
  @ApiOperation({ summary: 'Get shared files' })
  async getSharedFiles(
    @CurrentUser('id') userId: string,
    @Query('search') search?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: 'asc' | 'desc',
    @Query('type') type?: string,
    @Query('types') types?: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
    @Query('page') page?: number,
  ) {
    const { take, skip, currentPage } = parsePagination(limit, offset, page);
    const parsedTypes = parseTypesQuery(types, type);

    const { items, total } = await this.experimentsService.listSharedWithUser(
      userId,
      take,
      skip,
      {
        search: search?.trim() || undefined,
        sortBy: sortBy || undefined,
        sortOrder: sortOrder || 'asc',
        types: parsedTypes,
      },
    );

    const files = items.map((s) => ({
      ...this.mapNodeToDto(s.node),
      permission: s.permission,
      sharedAt: s.sharedAt.toISOString(),
    }));

    return {
      files,
      total,
      page: currentPage,
      limit: take,
      hasMore: skip + files.length < total,
    };
  }

  @Get('folder-path')
  @ApiOperation({ summary: 'Get breadcrumb path for a folder hierarchy' })
  async getFolderPath(
    @CurrentUser('id') userId?: string,
    @Query('folderId') folderId?: string,
  ) {
    if (folderId && folderId !== 'null' && userId) {
      await this.accessPolicy.assertCanAccess(userId, folderId, 'read');
    }
    const path = await this.experimentsService.getFolderPath(folderId);
    return { path };
  }

  @Get('starred')
  @ApiOperation({ summary: 'Get starred files' })
  async getStarredFiles(
    @CurrentUser('id') userId: string,
    @Query('spaceId') spaceId?: string,
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
    const parsedTypes = parseTypesQuery(types, type);
    const normalizedProjectId = normalizeExperimentProjectId(spaceId, userId);

    if (normalizedProjectId && userId) {
      await this.accessPolicy.assertCanAccessProject(
        userId,
        normalizedProjectId,
        'read',
      );
    }

    const result = await this.experimentsService.list({
      userId: normalizedProjectId ? undefined : userId,
      projectId: normalizedProjectId,
      scope: normalizedProjectId ? FileScope.Project : undefined,
      starredOnly: true,
      search: search?.trim() || undefined,
      sortBy: sortBy || undefined,
      sortOrder: sortOrder || 'asc',
      types: parsedTypes,
      limit: pagination.take,
      offset: pagination.skip,
    });
    return buildPaginatedExperimentsResponse(result, pagination);
  }

  @Get('usage')
  @ApiOperation({
    summary: 'Get current user or project storage usage and limit',
  })
  async getUsage(
    @CurrentUser('id') userId: string,
    @Query('spaceId') spaceId?: string,
  ) {
    const normalizedProjectId = normalizeExperimentProjectId(spaceId, userId);
    if (normalizedProjectId && userId) {
      await this.accessPolicy.assertCanAccessProject(
        userId,
        normalizedProjectId,
        'read',
      );
    }
    const targetSpaceId = normalizedProjectId ?? userId;
    const quota = this.filesPort
      ? await this.filesPort.getQuota(targetSpaceId)
      : null;
    const usedBigInt = quota ? quota.usedBytes : 0n;
    const maxBigInt = quota ? quota.maxBytes : DEFAULT_STORAGE_QUOTA_BYTES;
    const usedBytes = Number(usedBigInt);
    const maxBytes = Number(maxBigInt);
    const percentage =
      maxBigInt > 0n ? Number((usedBigInt * 10000n) / maxBigInt) / 100 : 100;

    return {
      usedBytes,
      maxBytes,
      limitBytes: maxBytes,
      percentage,
      usedFormatted: formatBytes(usedBytes),
      limitFormatted: formatBytes(maxBytes),
      scope: normalizedProjectId ? 'project' : 'personal',
    };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get file metadata by ID' })
  async getFileById(
    @Param('id') id: string,
    @CurrentUser('id') userId?: string,
  ) {
    const node = userId
      ? await this.accessPolicy.assertCanAccess(userId, id, 'read')
      : await this.experimentsService.getNodeById(id);
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
      await this.accessPolicy.assertCanAccess(userId, id, 'write');
    }
    const updated = await this.experimentsService.toggleStar(id, userId);
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
    const share = await this.experimentsService.shareNode(
      id,
      dto.userId,
      dto.permission,
    );
    return {
      success: true,
      share,
    };
  }

  private async createFolderForSpace(
    userId: string,
    rawSpaceId: string | undefined,
    dto: CreateFolderDto,
  ) {
    const normalizedProjectId = normalizeExperimentProjectId(rawSpaceId, userId);
    if (userId) {
      await this.accessPolicy.assertCanWriteScope(userId, {
        projectId: normalizedProjectId || null,
        parentId: dto.parentId || null,
      });
    }
    const created = await this.experimentsService.createFolder({
      userId,
      name: dto.name || dto.filename || 'New Folder',
      projectId: normalizedProjectId || null,
      linkedToId: normalizedProjectId || null,
      scope: normalizedProjectId ? FileScope.Project : FileScope.Personal,
      parentId: dto.parentId || null,
    });
    return this.mapNodeToDto(created);
  }

  @Post('folder')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new folder' })
  async createFolder(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateFolderDto,
  ) {
    return this.createFolderForSpace(userId, dto.spaceId, dto);
  }

  @Post('spaces/:spaceId/folder')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new folder in space scope' })
  async createScopedFolder(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateFolderDto,
    @Param('spaceId') spaceId?: string,
  ) {
    return this.createFolderForSpace(userId, spaceId ?? dto.spaceId, dto);
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
    const updated = await this.experimentsService.move(id, targetFolderId);
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
    if (!newName) throw new BadRequestException('New name is required');
    const updated = await this.experimentsService.rename(id, newName);
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
    const updated = await this.experimentsService.updateMetadata(
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
    const count = await this.trashService.softDelete(id);
    return { success: true, count };
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
    await this.assertBatchAccess(userId, dto.ids, 'write');
    await this.experimentsService.batchStar(dto.ids, dto.starred, userId);
    return { success: true };
  }

  @Post('batch/move')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Batch move multiple files or folders' })
  async batchMove(
    @Body() dto: BatchMoveDto,
    @CurrentUser('id') userId?: string,
  ) {
    const targetFolderId =
      dto.parentId !== undefined ? dto.parentId : (dto.targetFolderId ?? null);
    if (userId && targetFolderId) {
      await this.accessPolicy.assertCanAccess(userId, targetFolderId, 'write');
    }
    await this.assertBatchAccess(userId, dto.ids || [], 'write');
    const count = await this.experimentsService.batchMove(
      dto.ids || [],
      targetFolderId,
    );
    return { success: true, count };
  }
}
