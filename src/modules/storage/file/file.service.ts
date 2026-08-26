import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { FileRepository } from './file.repository';
import { R2Service } from '../r2/r2.service';
import { PrismaService } from '@/core/database/prisma.service';
import { Prisma, EntityType } from '@prisma/client';
import { DomainActivityEvent } from '@/modules/activity/events/activity.events';
import {
  PresignDto,
  UploadFileDto,
  CreateFolderDto,
  UpdateFileDto,
  ShareFileDto,
  QueryFilesDto,
} from './dto/file.dto';

export type FormattedFile<
  T extends {
    id: string;
    parentId?: string | null;
  },
> = T & {
  parent?: string | null;
};

@Injectable()
export class FileService {
  constructor(
    private readonly fileRepo: FileRepository,
    private readonly r2Service: R2Service,
    private readonly prisma: PrismaService,
    @Optional() private readonly eventEmitter?: EventEmitter2,
  ) {}

  private async resolveWorkspaceId(scope: {
    workspaceId?: string;
    projectId?: string;
    pageId?: string;
  }): Promise<string | null> {
    if (scope.workspaceId) {
      const ws = await this.prisma.workspace.findFirst({
        where: { OR: [{ id: scope.workspaceId }, { url: scope.workspaceId }] },
        select: { id: true },
      });
      if (ws) return ws.id;
    }

    if (scope.projectId) {
      const project = await this.prisma.project.findUnique({
        where: { id: scope.projectId },
        select: { workspaceId: true },
      });
      if (project) return project.workspaceId;
    }

    if (scope.pageId) {
      const page = await this.prisma.page.findUnique({
        where: { id: scope.pageId },
        select: { workspaceId: true },
      });
      if (page) return page.workspaceId;
    }

    return null;
  }

  private formatFile<
    T extends {
      id: string;
      parentId?: string | null;
    },
  >(f: T): FormattedFile<T>;
  private formatFile(f: null | undefined): null;
  private formatFile<
    T extends {
      id: string;
      parentId?: string | null;
    },
  >(f: T | null | undefined): FormattedFile<T> | null;
  private formatFile<
    T extends {
      id: string;
      parentId?: string | null;
    },
  >(f: T | null | undefined): FormattedFile<T> | null {
    if (!f) return null;
    return {
      ...f,
      parent: f.parentId,
    };
  }

  async presign(dto: PresignDto) {
    const key = dto.filename.startsWith('/')
      ? dto.filename.slice(1)
      : dto.filename;
    return this.r2Service.getPresignedUploadUrl(key, dto.mimeType);
  }

  async uploadR2Buffer(
    userId: string,
    filename: string,
    buffer: Buffer,
    mimeType = 'application/octet-stream',
    scope: { workspaceId?: string; projectId?: string; pageId?: string } = {},
  ) {
    const cleanName = filename.replace(/[^a-zA-Z0-9.-]/g, '_');
    const key = `uploads/${Date.now()}-${cleanName}`;
    const uploadRes = await this.r2Service.uploadBuffer(key, buffer, mimeType);

    return {
      url: uploadRes.url,
      path: uploadRes.path,
    };
  }

  async getR2Stream(key: string) {
    return this.r2Service.getObjectStream(key);
  }

  async upload(
    userId: string,
    scope: { workspaceId?: string; projectId?: string; pageId?: string },
    dto: UploadFileDto,
  ) {
    const workspaceId = await this.resolveWorkspaceId(scope);
    const linkedToType = scope.pageId
      ? 'Page'
      : scope.projectId
        ? 'Project'
        : workspaceId
          ? 'Workspace'
          : null;
    const linkedToId =
      scope.pageId || scope.projectId || workspaceId || null;
    const parentId =
      dto.parentId === 'null' || dto.parentId === 'undefined' || !dto.parentId
        ? null
        : dto.parentId;

    const file = await this.fileRepo.createFile({
      filename: dto.filename,
      isFolder: false,
      size: dto.size || 0,
      mimeType: dto.mimeType || 'application/octet-stream',
      url: dto.url || '',
      thumbnail: dto.thumbnail || null,
      parentId,
      metaData: (dto.metaData as Prisma.InputJsonValue) || {},
      authorId: userId,
      workspaceId,
      linkedToType,
      linkedToId,
    });

    return { file: this.formatFile(file) };
  }

  async createFolder(
    userId: string,
    scope: { workspaceId?: string; projectId?: string; pageId?: string },
    dto: CreateFolderDto,
  ) {
    const workspaceId = await this.resolveWorkspaceId(scope);
    const linkedToType = scope.pageId
      ? 'Page'
      : scope.projectId
        ? 'Project'
        : workspaceId
          ? 'Workspace'
          : null;
    const linkedToId =
      scope.pageId || scope.projectId || workspaceId || null;
    const parentId =
      dto.parentId === 'null' || dto.parentId === 'undefined' || !dto.parentId
        ? null
        : dto.parentId;

    const folder = await this.fileRepo.createFile({
      filename: dto.filename || dto.name || 'Untitled Folder',
      isFolder: true,
      parentId,
      authorId: userId,
      workspaceId,
      linkedToType,
      linkedToId,
    });

    return { folder: this.formatFile(folder) };
  }

  async getFile(fileId: string) {
    const file = await this.fileRepo.findFileById(fileId);

    if (!file) {
      throw new NotFoundException('File not found');
    }

    return { file: this.formatFile(file) };
  }

  async getFolderPath(folderId: string) {
    const path: { id: string | null; name: string }[] = [];
    let currentId: string | null = folderId;
    let depth = 0;
    const maxDepth = 20;

    while (currentId && depth < maxDepth) {
      const file = await this.fileRepo.findFileById(currentId);
      if (!file) break;
      path.unshift({ id: file.id, name: file.filename });
      currentId = file.parentId;
      depth++;
    }

    return { path };
  }

  async updateFile(fileId: string, dto: UpdateFileDto) {
    const file = await this.fileRepo.updateFile(fileId, {
      ...(dto.filename !== undefined && { filename: dto.filename }),
      ...(dto.starred !== undefined && { starred: dto.starred }),
      ...(dto.parentId !== undefined && { parentId: dto.parentId }),
      ...(dto.metaData !== undefined && {
        metaData: dto.metaData as Prisma.InputJsonValue,
      }),
    });

    return { file: this.formatFile(file) };
  }

  async deleteFile(fileId: string) {
    await this.fileRepo.updateFile(fileId, {
      trashedAt: new Date(),
    });
    return { message: 'File moved to trash' };
  }

  async batchDeleteFiles(ids: string[]) {
    if (!ids || ids.length === 0) return { message: 'No files provided', count: 0 };
    const res = await this.fileRepo.batchUpdateFiles(ids, {
      trashedAt: new Date(),
    });
    return { message: 'Files moved to trash', count: res.count };
  }

  async restoreFile(fileId: string) {
    await this.fileRepo.updateFile(fileId, {
      trashedAt: null,
    });
    return { message: 'File restored successfully' };
  }

  async batchRestoreFiles(ids: string[]) {
    if (!ids || ids.length === 0) return { message: 'No files provided', count: 0 };
    const res = await this.fileRepo.batchUpdateFiles(ids, {
      trashedAt: null,
    });
    return { message: 'Files restored successfully', count: res.count };
  }

  async permanentlyDeleteFile(fileId: string) {
    const file = await this.fileRepo.findFileById(fileId);

    if (file) {
      const deletePromises: Promise<unknown>[] = [
        this.fileRepo.deleteFile(fileId),
      ];
      if (file.url && file.url.includes('/api/files/r2/')) {
        const key = file.url.replace('/api/files/r2/', '');
        deletePromises.push(this.r2Service.deleteObject(key));
      }
      await Promise.all(deletePromises);
    }

    return { message: 'File permanently deleted' };
  }

  async batchPermanentlyDeleteFiles(ids: string[]) {
    if (!ids || ids.length === 0) return { message: 'No files provided', count: 0 };
    const files = await this.fileRepo.findFilesByIds(ids);

    const deletePromises: Promise<unknown>[] = [
      this.fileRepo.batchDeleteFiles(ids),
    ];

    for (const file of files) {
      if (file.url && file.url.includes('/api/files/r2/')) {
        const key = file.url.replace('/api/files/r2/', '');
        deletePromises.push(this.r2Service.deleteObject(key));
      }
    }

    await Promise.all(deletePromises);
    return { message: 'Files permanently deleted', count: files.length };
  }

  async toggleStar(fileId: string) {
    const file = await this.fileRepo.findFileById(fileId);
    if (!file) throw new NotFoundException('File not found');

    const updated = await this.fileRepo.updateFile(fileId, {
      starred: !file.starred,
    });

    return { file: this.formatFile(updated) };
  }

  async batchToggleStar(ids: string[], starred: boolean) {
    if (!ids || ids.length === 0) return { message: 'No files provided', count: 0 };
    const res = await this.fileRepo.batchUpdateFiles(ids, {
      starred,
    });
    return { message: `Files ${starred ? 'starred' : 'unstarred'} successfully`, count: res.count };
  }

  async renameFile(fileId: string, filename: string) {
    const file = await this.fileRepo.updateFile(fileId, {
      filename,
    });
    return { file: this.formatFile(file) };
  }

  async moveFile(fileId: string, parentId?: string) {
    const file = await this.fileRepo.updateFile(fileId, {
      parentId: parentId || null,
    });
    return { file: this.formatFile(file) };
  }

  async shareFile(fileId: string, dto: ShareFileDto) {
    const share = await this.fileRepo.upsertFileShare(
      fileId,
      dto.userId,
      dto.permission || 'view',
    );

    return { message: 'File shared successfully', share };
  }

  // ── Scoped Queries ──────────────────────────────────────────────────────────

  private buildTypeFilterConditions(typesStr?: string, singleType?: string): Prisma.FileWhereInput[] {
    const rawTypes = [
      ...(typesStr ? typesStr.split(',').map((t) => t.trim()) : []),
      ...(singleType && singleType !== 'all' ? [singleType.trim()] : []),
    ];
    const uniqueTypes = Array.from(new Set(rawTypes)).filter((t) => t && t !== 'all');

    if (uniqueTypes.length === 0) return [];

    const conditions: Prisma.FileWhereInput[] = [];

    for (const type of uniqueTypes) {
      switch (type) {
        case 'folder':
          conditions.push({ isFolder: true });
          break;
        case 'image':
          conditions.push({
            isFolder: false,
            OR: [
              { mimeType: { startsWith: 'image/' } },
              { filename: { endsWith: '.png', mode: 'insensitive' } },
              { filename: { endsWith: '.jpg', mode: 'insensitive' } },
              { filename: { endsWith: '.jpeg', mode: 'insensitive' } },
              { filename: { endsWith: '.webp', mode: 'insensitive' } },
              { filename: { endsWith: '.svg', mode: 'insensitive' } },
              { filename: { endsWith: '.gif', mode: 'insensitive' } },
            ],
          });
          break;
        case 'video':
          conditions.push({
            isFolder: false,
            OR: [
              { mimeType: { startsWith: 'video/' } },
              { filename: { endsWith: '.mp4', mode: 'insensitive' } },
              { filename: { endsWith: '.webm', mode: 'insensitive' } },
              { filename: { endsWith: '.mov', mode: 'insensitive' } },
              { filename: { endsWith: '.mkv', mode: 'insensitive' } },
            ],
          });
          break;
        case 'audio':
          conditions.push({
            isFolder: false,
            OR: [
              { mimeType: { startsWith: 'audio/' } },
              { filename: { endsWith: '.mp3', mode: 'insensitive' } },
              { filename: { endsWith: '.wav', mode: 'insensitive' } },
              { filename: { endsWith: '.ogg', mode: 'insensitive' } },
              { filename: { endsWith: '.m4a', mode: 'insensitive' } },
            ],
          });
          break;
        case 'document':
          conditions.push({
            isFolder: false,
            OR: [
              {
                mimeType: {
                  in: [
                    'application/pdf',
                    'application/msword',
                    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                    'text/plain',
                    'text/markdown',
                    'application/rtf',
                  ],
                },
              },
              { filename: { endsWith: '.pdf', mode: 'insensitive' } },
              { filename: { endsWith: '.doc', mode: 'insensitive' } },
              { filename: { endsWith: '.docx', mode: 'insensitive' } },
              { filename: { endsWith: '.txt', mode: 'insensitive' } },
              { filename: { endsWith: '.md', mode: 'insensitive' } },
              { filename: { endsWith: '.rtf', mode: 'insensitive' } },
            ],
          });
          break;
        case 'spreadsheet':
          conditions.push({
            isFolder: false,
            OR: [
              {
                mimeType: {
                  in: [
                    'application/vnd.ms-excel',
                    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                    'text/csv',
                    'text/tab-separated-values',
                  ],
                },
              },
              { filename: { endsWith: '.xls', mode: 'insensitive' } },
              { filename: { endsWith: '.xlsx', mode: 'insensitive' } },
              { filename: { endsWith: '.csv', mode: 'insensitive' } },
              { filename: { endsWith: '.tsv', mode: 'insensitive' } },
            ],
          });
          break;
        case 'archive':
          conditions.push({
            isFolder: false,
            OR: [
              {
                mimeType: {
                  in: [
                    'application/zip',
                    'application/x-rar-compressed',
                    'application/x-7z-compressed',
                    'application/x-tar',
                    'application/gzip',
                  ],
                },
              },
              { filename: { endsWith: '.zip', mode: 'insensitive' } },
              { filename: { endsWith: '.rar', mode: 'insensitive' } },
              { filename: { endsWith: '.7z', mode: 'insensitive' } },
              { filename: { endsWith: '.tar', mode: 'insensitive' } },
              { filename: { endsWith: '.gz', mode: 'insensitive' } },
            ],
          });
          break;
      }
    }

    return conditions;
  }

  private buildProjectFilterConditions(
    projectIdsStr?: string,
    singleProjectId?: string,
  ): Prisma.FileWhereInput[] {
    const rawProjects = [
      ...(projectIdsStr ? projectIdsStr.split(',').map((p) => p.trim()) : []),
      ...(singleProjectId && singleProjectId !== 'all'
        ? [singleProjectId.trim()]
        : []),
    ];
    const uniqueProjects = Array.from(new Set(rawProjects)).filter(
      (p) => p && p !== 'all',
    );

    if (uniqueProjects.length === 0) return [];

    const conditions: Prisma.FileWhereInput[] = [];

    const hasWorkspaceOnly = uniqueProjects.includes('workspace-only');
    const validProjectIds = uniqueProjects.filter((id) => id !== 'workspace-only');

    if (hasWorkspaceOnly) {
      conditions.push({
        OR: [
          { linkedToType: 'Workspace' },
          { linkedToId: null, linkedToType: null },
        ],
      });
    }

    if (validProjectIds.length > 0) {
      conditions.push({
        linkedToId: { in: validProjectIds },
        linkedToType: 'Project',
      });
    }

    return conditions;
  }

  private buildOrderBy(sortBy?: string): Prisma.FileOrderByWithRelationInput[] {
    switch (sortBy) {
      case 'name-asc':
        return [{ isFolder: 'desc' }, { filename: 'asc' }];
      case 'name-desc':
        return [{ isFolder: 'desc' }, { filename: 'desc' }];
      case 'date-asc':
        return [{ isFolder: 'desc' }, { updatedAt: 'asc' }];
      case 'size-desc':
        return [{ isFolder: 'desc' }, { size: 'desc' }];
      case 'size-asc':
        return [{ isFolder: 'desc' }, { size: 'asc' }];
      case 'date-desc':
      default:
        return [{ isFolder: 'desc' }, { updatedAt: 'desc' }];
    }
  }

  private applyCommonQueryFilters(
    where: Prisma.FileWhereInput,
    query?: QueryFilesDto,
  ) {
    if (!query) return;

    // 1. Search Query
    if (query.search && query.search.trim()) {
      where.filename = {
        contains: query.search.trim(),
        mode: 'insensitive',
      };
    }

    // 2. Types Filter
    const typeConditions = this.buildTypeFilterConditions(query.types, query.type);
    if (typeConditions.length > 0) {
      where.AND = [
        ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
        { OR: typeConditions },
      ];
    }

    // 3. Projects Filter
    const projectConditions = this.buildProjectFilterConditions(
      query.projectIds,
      query.projectId,
    );
    if (projectConditions.length > 0) {
      where.AND = [
        ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
        { OR: projectConditions },
      ];
    }
  }

  private parsePagination(query?: QueryFilesDto, defaultLimit = 40) {
    const page = query?.page
      ? Math.max(1, parseInt(String(query.page), 10) || 1)
      : 1;
    const limit = query?.limit
      ? Math.min(100, Math.max(1, parseInt(String(query.limit), 10) || defaultLimit))
      : defaultLimit;
    const skip = (page - 1) * limit;
    return { page, limit, skip };
  }

  async getFiles(
    scope: {
      workspaceId?: string;
      projectId?: string;
      pageId?: string;
      parentId?: string;
    },
    query?: QueryFilesDto,
  ) {
    const workspaceId = await this.resolveWorkspaceId(scope);
    const where: Prisma.FileWhereInput = {
      trashedAt: null,
    };

    if (scope.pageId) {
      where.linkedToId = scope.pageId;
      where.linkedToType = 'Page';
    } else if (scope.projectId) {
      where.linkedToId = scope.projectId;
      where.linkedToType = 'Project';
    } else if (workspaceId) {
      where.workspaceId = workspaceId;
    }

    const parentIdParam = query?.parentId !== undefined ? query.parentId : scope.parentId;
    if (parentIdParam !== undefined) {
      where.parentId =
        parentIdParam === 'null' || parentIdParam === 'undefined' || parentIdParam === ''
          ? null
          : parentIdParam;
    }

    this.applyCommonQueryFilters(where, query);

    const orderBy = this.buildOrderBy(query?.sortBy);
    const { page, limit, skip } = this.parsePagination(query, 40);

    const { files, total } = await this.fileRepo.findFilesWithCount(
      where,
      orderBy,
      limit,
      skip,
    );

    return {
      files: files.map((f) => this.formatFile(f)),
      total,
      page,
      limit,
      hasMore: skip + files.length < total,
    };
  }

  async getHomeFiles(workspaceParam: string, query?: QueryFilesDto) {
    const workspaceId =
      (await this.resolveWorkspaceId({ workspaceId: workspaceParam })) ||
      workspaceParam;
    const where: Prisma.FileWhereInput = {
      workspaceId,
      trashedAt: null,
      parentId: null,
    };

    this.applyCommonQueryFilters(where, query);

    const orderBy = this.buildOrderBy(query?.sortBy || 'date-desc');
    const { page, limit, skip } = this.parsePagination(query, 40);

    const { files, total } = await this.fileRepo.findFilesWithCount(
      where,
      orderBy,
      limit,
      skip,
    );

    return {
      files: files.map((f) => this.formatFile(f)),
      total,
      page,
      limit,
      hasMore: skip + files.length < total,
    };
  }

  async getMyFiles(
    userId: string,
    workspaceParam?: string,
    projectId?: string,
    query?: QueryFilesDto,
  ) {
    const workspaceId = workspaceParam
      ? (await this.resolveWorkspaceId({ workspaceId: workspaceParam })) ||
        workspaceParam
      : undefined;
    const where: Prisma.FileWhereInput = {
      authorId: userId,
      trashedAt: null,
      ...(workspaceId && { workspaceId }),
      ...(projectId && { linkedToId: projectId, linkedToType: 'Project' }),
    };

    this.applyCommonQueryFilters(where, query);

    const orderBy = this.buildOrderBy(query?.sortBy || 'date-desc');
    const { page, limit, skip } = this.parsePagination(query, 40);

    const { files, total } = await this.fileRepo.findFilesWithCount(
      where,
      orderBy,
      limit,
      skip,
    );

    return {
      files: files.map((f) => this.formatFile(f)),
      total,
      page,
      limit,
      hasMore: skip + files.length < total,
    };
  }

  async getStarredFiles(
    workspaceParam?: string,
    projectId?: string,
    query?: QueryFilesDto,
  ) {
    const workspaceId = workspaceParam
      ? (await this.resolveWorkspaceId({ workspaceId: workspaceParam })) ||
        workspaceParam
      : undefined;
    const where: Prisma.FileWhereInput = {
      starred: true,
      trashedAt: null,
      ...(workspaceId && { workspaceId }),
      ...(projectId && { linkedToId: projectId, linkedToType: 'Project' }),
    };

    this.applyCommonQueryFilters(where, query);

    const orderBy = this.buildOrderBy(query?.sortBy || 'date-desc');
    const { page, limit, skip } = this.parsePagination(query, 40);

    const { files, total } = await this.fileRepo.findFilesWithCount(
      where,
      orderBy,
      limit,
      skip,
    );

    return {
      files: files.map((f) => this.formatFile(f)),
      total,
      page,
      limit,
      hasMore: skip + files.length < total,
    };
  }

  async getSharedFiles(
    userId: string,
    workspaceParam?: string,
    projectId?: string,
    query?: QueryFilesDto,
  ) {
    const workspaceId = workspaceParam
      ? (await this.resolveWorkspaceId({ workspaceId: workspaceParam })) ||
        workspaceParam
      : undefined;
    const shares = await this.fileRepo.findFileShares(userId);

    let files = shares
      .map((s) => s.file)
      .filter((f) => {
        if (!f || f.trashedAt) return false;
        if (workspaceId && f.workspaceId !== workspaceId) return false;
        if (
          projectId &&
          (f.linkedToId !== projectId || f.linkedToType !== 'Project')
        )
          return false;
        return true;
      });

    if (query?.search && query.search.trim()) {
      const q = query.search.trim().toLowerCase();
      files = files.filter((f) => f.filename?.toLowerCase().includes(q));
    }

    if (query?.types || (query?.type && query.type !== 'all')) {
      const allowedTypes = [
        ...(query?.types ? query.types.split(',').map((t) => t.trim()) : []),
        ...(query?.type && query.type !== 'all' ? [query.type.trim()] : []),
      ];
      files = files.filter((f) => {
        if (allowedTypes.includes('folder') && f.isFolder) return true;
        if (allowedTypes.includes('image') && f.mimeType?.startsWith('image/'))
          return true;
        if (allowedTypes.includes('video') && f.mimeType?.startsWith('video/'))
          return true;
        if (allowedTypes.includes('audio') && f.mimeType?.startsWith('audio/'))
          return true;
        return true;
      });
    }

    const { page, limit, skip } = this.parsePagination(query, 40);
    const total = files.length;
    const paginatedFiles = files.slice(skip, skip + limit);

    return {
      files: paginatedFiles.map((f) => this.formatFile(f)),
      total,
      page,
      limit,
      hasMore: skip + paginatedFiles.length < total,
    };
  }

  async getTrashedFiles(
    workspaceParam?: string,
    projectId?: string,
    query?: QueryFilesDto,
  ) {
    const workspaceId = workspaceParam
      ? (await this.resolveWorkspaceId({ workspaceId: workspaceParam })) ||
        workspaceParam
      : undefined;
    const where: Prisma.FileWhereInput = {
      trashedAt: { not: null },
      ...(workspaceId && { workspaceId }),
      ...(projectId && { linkedToId: projectId, linkedToType: 'Project' }),
    };

    this.applyCommonQueryFilters(where, query);

    const orderBy = this.buildOrderBy(query?.sortBy || 'date-desc');
    const { page, limit, skip } = this.parsePagination(query, 40);

    const { files, total } = await this.fileRepo.findFilesWithCount(
      where,
      orderBy,
      limit,
      skip,
    );

    return {
      files: files.map((f) => this.formatFile(f)),
      total,
      page,
      limit,
      hasMore: skip + files.length < total,
    };
  }
}
