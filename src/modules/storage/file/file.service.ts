import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Optional,
  Logger,
} from '@nestjs/common';
import { FastifyRequest } from 'fastify';
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
  private readonly logger = new Logger(FileService.name);

  constructor(
    private readonly fileRepo: FileRepository,
    private readonly r2Service: R2Service,
    private readonly prisma: PrismaService,
    @Optional() private readonly eventEmitter?: EventEmitter2,
  ) {}

  private async assertCanWriteScope(
    userId: string,
    scope: { workspaceId?: string; projectId?: string; pageId?: string },
  ): Promise<void> {
    if (scope.pageId) {
      const page = await this.fileRepo.findPageScope(scope.pageId);
      if (!page) throw new NotFoundException('Page not found');
      return this.assertCanWriteScope(userId, {
        projectId: page.projectId || undefined,
        workspaceId: page.workspaceId,
      });
    }

    if (scope.projectId) {
      const project = await this.fileRepo.findProjectScope(scope.projectId);
      if (!project) throw new NotFoundException('Project not found');

      const wsRole = await this.fileRepo.findWorkspaceMemberRole(
        project.workspaceId,
        userId,
      );
      if (wsRole === 'owner' || wsRole === 'admin') return;

      const projRole = await this.fileRepo.findProjectMemberRole(
        scope.projectId,
        userId,
      );
      if (projRole === 'admin' || projRole === 'contributor') return;
      throw new ForbiddenException('Insufficient file permissions');
    }

    if (scope.workspaceId) {
      const role = await this.fileRepo.findWorkspaceMemberRole(
        scope.workspaceId,
        userId,
      );
      if (role && role !== 'viewer') return;
      throw new ForbiddenException('Insufficient file permissions');
    }
  }

  private async assertCanAccessFile(
    userId: string,
    fileId: string,
    mode: 'read' | 'write',
  ) {
    const file = await this.fileRepo.findFileById(fileId);
    if (!file) throw new NotFoundException('File not found');
    if (file.authorId === userId) return file;

    const share = await this.fileRepo.findFileShare(fileId, userId);
    if (share && (mode === 'read' || share.permission === 'edit')) return file;

    throw new ForbiddenException('Insufficient file permissions');
  }

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

  /**
   * Deepened entry point for parsing and storing raw multipart stream uploads.
   */
  async uploadMultipartStream(req: FastifyRequest, userId?: string) {
    if (!req.isMultipart || !req.isMultipart()) {
      throw new BadRequestException('Request must be multipart/form-data');
    }

    const data = await req.file();
    if (!data) {
      throw new BadRequestException('No file found in request');
    }

    const buffer = await data.toBuffer();
    const filename = data.filename || 'unnamed-file';
    const mimeType = data.mimetype || 'application/octet-stream';

    // Parse additional form fields safely
    const reqUser = (req as unknown as { user?: { id?: string; sub?: string } })
      ?.user;
    const authorId = userId || reqUser?.id || reqUser?.sub || '';
    const fields = (data.fields || {}) as Record<
      string,
      { value?: string } | string | undefined
    >;
    const getFieldValue = (
      field: { value?: string } | string | undefined,
    ): string | undefined => {
      if (typeof field === 'string') return field;
      if (field && typeof field.value === 'string') return field.value;
      return undefined;
    };

    const workspaceId = getFieldValue(fields.workspaceId);
    const projectId = getFieldValue(fields.projectId);
    const pageId = getFieldValue(fields.pageId);

    return this.uploadR2Buffer(authorId, filename, buffer, mimeType, {
      workspaceId,
      projectId,
      pageId,
    });
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

    const linkedToType = scope.pageId
      ? 'Page'
      : scope.projectId
        ? 'Project'
        : scope.workspaceId
          ? 'Workspace'
          : null;
    const linkedToId =
      scope.pageId || scope.projectId || scope.workspaceId || null;

    let file = null;
    try {
      if (userId) {
        file = await this.fileRepo.createFile({
          filename,
          isFolder: false,
          size: buffer.length,
          mimeType,
          url: uploadRes.url,
          thumbnail: null,
          parentId: null,
          metaData: {},
          authorId: userId,
          workspaceId: scope.workspaceId || null,
          linkedToType,
          linkedToId,
        });

        this.eventEmitter?.emit(
          'file.created',
          new DomainActivityEvent({
            entityType: 'file' as unknown as EntityType,
            entityId: file.id,
            verb: 'uploaded',
            actorId: userId,
            workspaceId: scope.workspaceId || '',
            projectId: scope.projectId || undefined,
          }),
        );
      }
    } catch (dbErr) {
      // Database record creation is optional for raw asset uploads (e.g. avatars, temp files)
      this.logger.warn(
        `Failed to create database record for uploaded file: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`,
      );
    }

    return {
      file: file ? this.formatFile(file) : null,
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
    await this.assertCanWriteScope(userId, scope);
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
    await this.assertCanWriteScope(userId, scope);
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

  async getFile(fileId: string, userId: string) {
    const file = await this.assertCanAccessFile(userId, fileId, 'read');
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

  async updateFile(fileId: string, userId: string, dto: UpdateFileDto) {
    await this.assertCanAccessFile(userId, fileId, 'write');
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

  async deleteFile(fileId: string, userId: string) {
    await this.assertCanAccessFile(userId, fileId, 'write');
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

  async restoreFile(fileId: string, userId: string) {
    await this.assertCanAccessFile(userId, fileId, 'write');
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

  async permanentlyDeleteFile(fileId: string, userId: string) {
    const file = await this.assertCanAccessFile(userId, fileId, 'write');

    const deletePromises: Promise<unknown>[] = [this.fileRepo.deleteFile(fileId)];
    if (file.url && file.url.includes('/api/files/r2/')) {
      const key = file.url.replace('/api/files/r2/', '');
      deletePromises.push(this.r2Service.deleteObject(key));
    }
    await Promise.all(deletePromises);

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

  async toggleStar(fileId: string, userId: string) {
    const file = await this.assertCanAccessFile(userId, fileId, 'write');

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

  async renameFile(fileId: string, userId: string, filename: string) {
    await this.assertCanAccessFile(userId, fileId, 'write');
    const file = await this.fileRepo.updateFile(fileId, {
      filename,
    });
    return { file: this.formatFile(file) };
  }

  async moveFile(fileId: string, userId: string, parentId?: string) {
    await this.assertCanAccessFile(userId, fileId, 'write');
    const file = await this.fileRepo.updateFile(fileId, {
      parentId: parentId || null,
    });
    return { file: this.formatFile(file) };
  }

  async shareFile(fileId: string, userId: string, dto: ShareFileDto) {
    await this.assertCanAccessFile(userId, fileId, 'write');
    const share = await this.fileRepo.upsertFileShare(
      fileId,
      dto.userId,
      dto.permission || 'view',
    );

    return { message: 'File shared successfully', share };
  }

  async getShareSettings(fileId: string, userId: string) {
    await this.assertCanAccessFile(userId, fileId, 'read');
    const shares = await this.fileRepo.getFileShares(fileId);
    return { shares };
  }

  // ── Scoped Queries ──────────────────────────────────────────────────────────

  async getFiles(scope: {
    workspaceId?: string;
    projectId?: string;
    pageId?: string;
    parentId?: string;
  }) {
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

    if (scope.parentId !== undefined) {
      where.parentId =
        scope.parentId === 'null' || scope.parentId === 'undefined' || scope.parentId === ''
          ? null
          : scope.parentId;
    }

    const files = await this.fileRepo.findFiles(
      where,
      [{ isFolder: 'desc' }, { filename: 'asc' }],
    );

    return { files: files.map((f) => this.formatFile(f)) };
  }

  async getHomeFiles(workspaceParam: string) {
    const workspaceId = (await this.resolveWorkspaceId({ workspaceId: workspaceParam })) || workspaceParam;
    const files = await this.fileRepo.findFiles(
      {
        workspaceId,
        trashedAt: null,
        parentId: null,
      },
      [{ isFolder: 'desc' }, { createdAt: 'desc' }],
      50,
    );

    return { files: files.map((f) => this.formatFile(f)) };
  }

  async getMyFiles(userId: string, workspaceParam?: string, projectId?: string) {
    const workspaceId = workspaceParam
      ? (await this.resolveWorkspaceId({ workspaceId: workspaceParam })) || workspaceParam
      : undefined;
    const files = await this.fileRepo.findFiles(
      {
        authorId: userId,
        trashedAt: null,
        ...(workspaceId && { workspaceId }),
        ...(projectId && { linkedToId: projectId, linkedToType: 'Project' }),
      },
      [{ createdAt: 'desc' }],
    );

    return { files: files.map((f) => this.formatFile(f)) };
  }

  async getStarredFiles(workspaceParam?: string, projectId?: string) {
    const workspaceId = workspaceParam
      ? (await this.resolveWorkspaceId({ workspaceId: workspaceParam })) || workspaceParam
      : undefined;
    const files = await this.fileRepo.findFiles(
      {
        starred: true,
        trashedAt: null,
        ...(workspaceId && { workspaceId }),
        ...(projectId && { linkedToId: projectId, linkedToType: 'Project' }),
      },
      [{ updatedAt: 'desc' }],
    );

    return { files: files.map((f) => this.formatFile(f)) };
  }

  async getSharedFiles(
    userId: string,
    workspaceParam?: string,
    projectId?: string,
  ) {
    const workspaceId = workspaceParam
      ? (await this.resolveWorkspaceId({ workspaceId: workspaceParam })) || workspaceParam
      : undefined;
    const shares = await this.fileRepo.findFileShares(userId);

    const files = shares
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

    return { files: files.map((f) => this.formatFile(f)) };
  }

  async getTrashedFiles(workspaceParam?: string, projectId?: string) {
    const workspaceId = workspaceParam
      ? (await this.resolveWorkspaceId({ workspaceId: workspaceParam })) || workspaceParam
      : undefined;
    const files = await this.fileRepo.findFiles(
      {
        trashedAt: { not: null },
        ...(workspaceId && { workspaceId }),
        ...(projectId && { linkedToId: projectId, linkedToType: 'Project' }),
      },
      [{ trashedAt: 'desc' }],
    );

    return { files: files.map((f) => this.formatFile(f)) };
  }
}
