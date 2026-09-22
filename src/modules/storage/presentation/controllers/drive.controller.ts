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
  Optional,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '@/modules/identity/auth';
import { CurrentUser } from '@/modules/identity/auth';
import { ListDriveUseCase } from '../../application/use-cases/drive/list-drive.use-case';
import { MoveNodeUseCase } from '../../application/use-cases/drive/move-node.use-case';
import { SoftDeleteUseCase } from '../../application/use-cases/trash/soft-delete.use-case';
import { IStorageNodeRepository } from '../../domain/ports/storage-node.repository.port';
import { STORAGE_NODE_REPOSITORY } from '../../storage.tokens';
import { Inject } from '@nestjs/common';
import { StorageNode } from '../../domain/entities/storage-node.entity';
import { FileScope } from '../../domain/value-objects/file-scope.vo';
import { PrismaService } from '@/core/database/prisma.service';
import { FilePermission } from '@prisma/client';
import { StorageNodeMapper } from '../../infrastructure/persistence/mappers/storage-node.mapper';
import {
  CreateFolderDto,
  MoveFileDto,
  RenameFileDto,
  ShareFileDto,
  BatchFileIdsDto,
  BatchStarDto,
} from '../dto/file.dto';
import * as crypto from 'crypto';

@ApiTags('Storage & Drive')
@ApiBearerAuth('JWT-auth')
@Controller(['api/v1/storage/files', 'api/files', 'api/file'])
@UseGuards(JwtAuthGuard)
export class DriveController {
  constructor(
    private readonly listDriveUseCase: ListDriveUseCase,
    private readonly moveNodeUseCase: MoveNodeUseCase,
    private readonly softDeleteUseCase: SoftDeleteUseCase,
    @Inject(STORAGE_NODE_REPOSITORY)
    private readonly nodeRepo: IStorageNodeRepository,
    @Optional()
    private readonly prisma?: PrismaService,
  ) {}

  private mapNodeToDto(node: StorageNode) {
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
      url: `/api/files/${encodeURIComponent(node.id)}/content`,
      thumbnail: (node.metadata as any)?.thumbnail || null,
      metaData: node.metadata || {},
      trashedAt: node.trashedAt ? node.trashedAt.toISOString() : null,
      author: {
        id: node.authorId,
        name: 'Researcher',
        email: '',
        avatar: '',
      },
      createdAt: node.createdAt
        ? node.createdAt.toISOString()
        : new Date().toISOString(),
      updatedAt: node.updatedAt
        ? node.updatedAt.toISOString()
        : new Date().toISOString(),
    };
  }

  @Get('my-files')
  @ApiOperation({ summary: 'Get current user personal files and folders' })
  async getMyFiles(
    @CurrentUser('id') userId: string,
    @Query('parentId') parentId?: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
    @Query('page') page?: number,
  ) {
    const take = limit ? Number(limit) : 100;
    const skip =
      offset !== undefined
        ? Number(offset)
        : page
          ? (Number(page) - 1) * take
          : 0;
    const currentPage = page ? Number(page) : Math.floor(skip / take) + 1;

    const result = await this.listDriveUseCase.execute({
      userId,
      parentId:
        !parentId || parentId === 'null' || parentId === 'root'
          ? null
          : parentId,
      limit: take,
      offset: skip,
    });
    const files = (result.nodes || []).map((node) => this.mapNodeToDto(node));
    return {
      files,
      items: files,
      total: result.total,
      page: currentPage,
      limit: take,
      hasMore: skip + files.length < result.total,
    };
  }

  @Get(['shared', 'me/shared'])
  @ApiOperation({ summary: 'Get shared files' })
  async getSharedFiles(
    @CurrentUser('id') userId: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
    @Query('page') page?: number,
  ) {
    const take = limit ? Number(limit) : 100;
    const skip =
      offset !== undefined
        ? Number(offset)
        : page
          ? (Number(page) - 1) * take
          : 0;
    const currentPage = page ? Number(page) : Math.floor(skip / take) + 1;

    if (!this.prisma) {
      return {
        items: [],
        files: [],
        total: 0,
        page: currentPage,
        limit: take,
        totalPages: 0,
        hasMore: false,
      };
    }

    const [shares, total] = await Promise.all([
      this.prisma.fileShare.findMany({
        where: {
          userId,
          file: {
            trashedAt: null,
          },
        },
        include: {
          file: true,
        },
        orderBy: {
          createdAt: 'desc',
        },
        take,
        skip,
      }),
      this.prisma.fileShare.count({
        where: {
          userId,
          file: {
            trashedAt: null,
          },
        },
      }),
    ]);

    const files = shares
      .filter((s) => s.file)
      .map((s) => {
        const node = StorageNodeMapper.toDomain(s.file);
        const dto = this.mapNodeToDto(node);
        return {
          ...dto,
          permission: s.permission,
          sharedAt: s.createdAt.toISOString(),
        };
      });

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
    if (!folderId || folderId === 'null') return { path: [] };
    const path: Array<{ id: string; name: string }> = [];
    let currentId: string | null = folderId;
    let depth = 0;
    while (currentId && depth < 20) {
      const node = await this.nodeRepo.findById(currentId);
      if (!node) break;
      path.unshift({ id: node.id, name: node.name });
      currentId = node.parentId;
      depth++;
    }
    return { path };
  }

  @Get(['pages/:pageId', 'page/:pageId'])
  @ApiOperation({ summary: 'List files associated with a page' })
  async getPageFiles(
    @Param('pageId') pageId: string,
    @Query('parentId') parentId?: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
    @Query('page') page?: number,
  ) {
    const take = limit ? Number(limit) : 100;
    const skip =
      offset !== undefined
        ? Number(offset)
        : page
          ? (Number(page) - 1) * take
          : 0;
    const currentPage = page ? Number(page) : Math.floor(skip / take) + 1;

    const result = await this.listDriveUseCase.execute({
      scope: FileScope.Page,
      projectId: pageId,
      parentId: parentId || null,
      limit: take,
      offset: skip,
    });
    const files = (result.nodes || []).map((node: StorageNode) =>
      this.mapNodeToDto(node),
    );
    return {
      files,
      items: files,
      total: result.total,
      page: currentPage,
      limit: take,
      hasMore: skip + files.length < result.total,
    };
  }

  @Get('starred')
  @ApiOperation({ summary: 'Get starred files' })
  async getStarredFiles(
    @CurrentUser('id') userId: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
    @Query('page') page?: number,
  ) {
    const take = limit ? Number(limit) : 100;
    const skip =
      offset !== undefined
        ? Number(offset)
        : page
          ? (Number(page) - 1) * take
          : 0;
    const currentPage = page ? Number(page) : Math.floor(skip / take) + 1;

    const result = await this.listDriveUseCase.execute({
      userId,
      starredOnly: true,
      limit: take,
      offset: skip,
    });
    const files = (result.nodes || []).map((node: StorageNode) =>
      this.mapNodeToDto(node),
    );
    return {
      files,
      items: files,
      total: result.total,
      page: currentPage,
      limit: take,
      hasMore: skip + files.length < result.total,
    };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get file metadata by ID' })
  async getFileById(@Param('id') id: string) {
    const node = await this.nodeRepo.findById(id);
    if (!node || node.isTrashed()) {
      throw new NotFoundException('File not found');
    }
    return this.mapNodeToDto(node);
  }

  @Put(':id/star')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Toggle star status on a file or folder' })
  async toggleStar(@Param('id') id: string) {
    const node = await this.nodeRepo.findById(id);
    if (!node || node.isTrashed()) {
      throw new NotFoundException('Node not found');
    }
    node.toggleStar();
    await this.nodeRepo.update(node);
    return { success: true, starred: node.starred };
  }

  @Put([':id/share', 'files/:id/share'])
  @Post([':id/share', 'files/:id/share'])
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Share a file with another user' })
  async shareFile(
    @Param('id') id: string,
    @CurrentUser('id') _currentUserId: string,
    @Body() dto: ShareFileDto,
  ) {
    const node = await this.nodeRepo.findById(id);
    if (!node || node.isTrashed()) {
      throw new NotFoundException('File not found');
    }

    if (!this.prisma) {
      throw new NotFoundException('Storage sharing database service unavailable');
    }

    const permission =
      dto.permission === 'edit' ? FilePermission.edit : FilePermission.view;

    const share = await this.prisma.fileShare.upsert({
      where: {
        fileId_userId: {
          fileId: id,
          userId: dto.userId,
        },
      },
      update: {
        permission,
      },
      create: {
        fileId: id,
        userId: dto.userId,
        permission,
      },
    });

    return {
      success: true,
      share: {
        id: share.id,
        fileId: share.fileId,
        userId: share.userId,
        permission: share.permission,
        createdAt: share.createdAt.toISOString(),
      },
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
    const folder = new StorageNode({
      id: crypto.randomUUID(),
      name: folderName,
      isFolder: true,
      size: 0n,
      parentId: dto.parentId || null,
      authorId: userId,
    });
    const created = await this.nodeRepo.create(folder);
    return this.mapNodeToDto(created);
  }

  @Post([
    'pages/:pageId/folder',
    'page/:pageId/folder',
    'projects/:projectId/folder',
    'project/:projectId/folder',
  ])
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new folder in page or project scope' })
  async createScopedFolder(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateFolderDto,
    @Param('pageId') pageId?: string,
    @Param('projectId') projectId?: string,
  ) {
    const folderName = dto.name || dto.filename || 'New Folder';
    const folder = new StorageNode({
      id: crypto.randomUUID(),
      projectId: projectId || null,
      name: folderName,
      isFolder: true,
      size: 0n,
      parentId: dto.parentId || null,
      authorId: userId,
      metadata: pageId ? { pageId } : {},
    });
    const created = await this.nodeRepo.create(folder);
    return this.mapNodeToDto(created);
  }

  @Post('move')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Move a file or folder' })
  async moveNode(@Body() dto: MoveFileDto & { fileId?: string; id?: string }) {
    const targetId = dto.fileId || dto.id;
    if (!targetId) throw new NotFoundException('fileId is required');
    const updated = await this.moveNodeUseCase.execute(
      targetId,
      dto.parentId || null,
    );
    return this.mapNodeToDto(updated);
  }

  @Put(':id/move')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Move a file or folder by ID' })
  async moveNodeById(
    @Param('id') id: string,
    @Body() dto: { parentId?: string | null; targetFolderId?: string | null },
  ) {
    const targetFolderId =
      dto.parentId !== undefined ? dto.parentId : (dto.targetFolderId ?? null);
    const updated = await this.moveNodeUseCase.execute(id, targetFolderId);
    return this.mapNodeToDto(updated);
  }

  @Put(':id/rename')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rename a file or folder' })
  async renameNode(@Param('id') id: string, @Body() dto: RenameFileDto) {
    const node = await this.nodeRepo.findById(id);
    if (!node || node.isTrashed()) {
      throw new NotFoundException('Node not found');
    }
    const newName = dto.name || dto.filename;
    if (!newName) throw new NotFoundException('New name is required');
    node.rename(newName);
    const updated = await this.nodeRepo.update(node);
    return this.mapNodeToDto(updated);
  }

  @Put(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update file metadata and description' })
  async updateNodeMetadata(
    @Param('id') id: string,
    @Body() dto: { metaData?: Record<string, any>; description?: string },
  ) {
    const node = await this.nodeRepo.findById(id);
    if (!node || node.isTrashed()) {
      throw new NotFoundException('Node not found');
    }
    const currentMeta = node.metadata || {};
    const updatedMeta = {
      ...currentMeta,
      ...(dto.metaData || {}),
      ...(dto.description !== undefined
        ? { description: dto.description }
        : {}),
    };
    (node as any)._metadata = updatedMeta;
    (node as any)._updatedAt = new Date();
    await this.nodeRepo.update(node);
    return this.mapNodeToDto(node);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Move file to trash' })
  async deleteFile(@Param('id') id: string) {
    return this.softDeleteUseCase.execute(id);
  }

  @Post('batch/delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Batch move files to trash' })
  async batchDelete(@Body() dto: BatchFileIdsDto) {
    let count = 0;
    for (const id of dto.ids) {
      try {
        await this.softDeleteUseCase.execute(id);
        count++;
      } catch {
        // Best-effort batch deletion
      }
    }
    return { success: true, count };
  }

  @Post('batch/star')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Batch star/unstar files' })
  async batchStar(@Body() dto: BatchStarDto) {
    for (const id of dto.ids) {
      const node = await this.nodeRepo.findById(id);
      if (node) {
        if (dto.starred !== node.starred) {
          node.toggleStar();
          await this.nodeRepo.update(node);
        }
      }
    }
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
  ) {
    const targetFolderId =
      dto.parentId !== undefined ? dto.parentId : (dto.targetFolderId ?? null);
    const ids = dto.ids || [];
    let count = 0;
    for (const id of ids) {
      try {
        await this.moveNodeUseCase.execute(id, targetFolderId);
        count++;
      } catch {
        // Best-effort batch move
      }
    }
    return { success: true, count };
  }
}
