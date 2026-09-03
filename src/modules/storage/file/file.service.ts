import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
  Optional,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { FileRepository } from './file.repository';
import { R2Service } from '../r2/r2.service';
import { parseByteRange } from './utils/range.utils';
import { PrismaService } from '@/core/database/prisma.service';
import { Prisma, EntityType } from '@prisma/client';
import { DomainActivityEvent } from '@/modules/activity/events/activity.events';
import { RedisCacheService } from '@/core/cache/redis-cache.service';
import { STORAGE_REDIS_KEYS } from './constants/redis-keys.constant';
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

export const NON_WORKSPACE_STORAGE_EXCLUSION: Prisma.FileWhereInput['NOT'] = [
  { linkedToType: { in: ['Project', 'Page', 'Library', 'Paper'] } },
  { metaData: { path: ['source'], equals: 'library' } },
  { metaData: { path: ['source'], equals: 'paper' } },
  { attachments: { some: {} } },
];

@Injectable()
export class FileService implements OnModuleInit {
  private readonly logger = new Logger(FileService.name);

  constructor(
    private readonly fileRepo: FileRepository,
    private readonly r2Service: R2Service,
    private readonly prisma: PrismaService,
    @Optional() private readonly eventEmitter?: EventEmitter2,
    @Optional() private readonly cache?: RedisCacheService,
  ) {}

  async onModuleInit() {
    try {
      // Self-healing migration: update legacy library files in files table to linkedToType: 'Library'
      const updated = await this.prisma.file.updateMany({
        where: {
          linkedToType: 'Workspace',
          OR: [
            { metaData: { path: ['source'], equals: 'library' } },
            { metaData: { path: ['source'], equals: 'paper' } },
            { attachments: { some: {} } },
          ],
        },
        data: {
          linkedToType: 'Library',
        },
      });
      if (updated.count > 0) {
        this.logger.log(
          `[Remediation] Isolated ${updated.count} legacy library files from Workspace Storage`,
        );
      }
    } catch (err) {
      this.logger.debug?.(
        `[Remediation] Legacy library file isolation check bypassed: ${err}`,
      );
    }
  }

  private async invalidateStorageCache(
    workspaceId?: string | null,
    fileId?: string,
  ) {
    if (!this.cache) return;
    const promises: Promise<any>[] = [];
    if (workspaceId) {
      promises.push(
        this.cache.delPattern(`flux:storage:tree:${workspaceId}:*`),
      );
      promises.push(this.cache.del(STORAGE_REDIS_KEYS.quota(workspaceId)));
    }
    if (fileId) {
      promises.push(this.cache.del(STORAGE_REDIS_KEYS.file(fileId)));
    }
    await Promise.all(promises).catch((err) => {
      this.logger.warn(`Failed to invalidate storage cache: ${err}`);
    });
  }

  private async validateNoCircularFolder(
    folderId: string,
    targetParentId: string,
  ): Promise<void> {
    if (folderId === targetParentId) {
      throw new BadRequestException('A folder cannot be moved inside itself');
    }

    let currentParentId: string | null = targetParentId;
    const visited = new Set<string>();

    while (currentParentId) {
      if (currentParentId === folderId) {
        throw new BadRequestException('Circular folder move detected');
      }
      if (visited.has(currentParentId)) break;
      visited.add(currentParentId);

      const parentFolder = await this.fileRepo.findFileById(currentParentId);
      currentParentId = parentFolder?.parentId || null;
    }
  }

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

      const role = await this.fileRepo.findProjectMemberRole(
        scope.projectId,
        userId,
      );
      if (!role) {
        throw new ForbiddenException('You are not a member of this project');
      }
      if (role === 'viewer') {
        throw new ForbiddenException(
          'Viewers cannot upload files to this project',
        );
      }
      return;
    }

    if (scope.workspaceId) {
      const workspace = await this.resolveWorkspace(scope.workspaceId);
      if (!workspace) throw new NotFoundException('Workspace not found');

      const role = await this.fileRepo.findWorkspaceMemberRole(
        workspace.id,
        userId,
      );
      if (!role) {
        throw new ForbiddenException('You are not a member of this workspace');
      }
      if (role === 'viewer') {
        throw new ForbiddenException(
          'Viewers cannot upload files to this workspace',
        );
      }
    }
  }

  private async assertCanAccessFile(
    userId: string,
    fileId: string,
    required: 'read' | 'write' = 'read',
  ) {
    const file = await this.fileRepo.findFileById(fileId);
    if (!file) throw new NotFoundException('File not found');

    if (required === 'write') {
      let isLibraryFile =
        file.linkedToType === 'Library' ||
        file.linkedToType === 'Paper' ||
        (file.metaData as any)?.source === 'library' ||
        (file.metaData as any)?.source === 'paper' ||
        (Array.isArray((file as any).attachments) &&
          (file as any).attachments.length > 0);

      if (!isLibraryFile && this.prisma?.catalogAttachment) {
        const attCount = await this.prisma.catalogAttachment.count({
          where: { fileId: file.id },
        });
        if (attCount > 0) isLibraryFile = true;
      }

      if (isLibraryFile) {
        throw new ForbiddenException(
          'Cannot modify or delete Library documents through Storage Drive APIs. Use the Library module.',
        );
      }
    }

    if (file.authorId === userId) return file;

    const directShare = file.sharedWith?.find((s) => s.userId === userId);
    if (directShare) {
      if (required === 'write' && directShare.permission !== 'edit') {
        throw new ForbiddenException('You only have view access to this file');
      }
      return file;
    }

    if (file.workspaceId) {
      const role = await this.fileRepo.findWorkspaceMemberRole(
        file.workspaceId,
        userId,
      );
      if (role) {
        if (required === 'write' && role === 'viewer') {
          throw new ForbiddenException(
            'Viewers cannot modify files in this workspace',
          );
        }
        return file;
      }
    }

    if (file.linkedToType === 'Project' && file.linkedToId) {
      const role = await this.fileRepo.findProjectMemberRole(
        file.linkedToId,
        userId,
      );
      if (role) {
        if (required === 'write' && role === 'viewer') {
          throw new ForbiddenException(
            'Viewers cannot modify files in this project',
          );
        }
        return file;
      }
    }

    if (
      file.linkedToType === 'Paper' &&
      file.linkedToId &&
      this.prisma?.catalogItem
    ) {
      const paper = await this.prisma.catalogItem.findUnique({
        where: { id: file.linkedToId },
        select: { workspaceId: true },
      });
      if (paper?.workspaceId) {
        const role = await this.fileRepo.findWorkspaceMemberRole(
          paper.workspaceId,
          userId,
        );
        if (role) {
          if (required === 'write' && role === 'viewer') {
            throw new ForbiddenException(
              'Viewers cannot modify files in this workspace',
            );
          }
          return file;
        }
      }
    }

    throw new ForbiddenException('You do not have access to this file');
  }

  private async resolveWorkspace(workspaceIdOrSlug: string) {
    return this.prisma.workspace.findFirst({
      where: {
        OR: [
          { id: workspaceIdOrSlug },
          { slug: workspaceIdOrSlug },
          { url: workspaceIdOrSlug },
        ],
        deletedAt: null,
      },
      select: { id: true },
    });
  }

  private async resolveWorkspaceId(scope: {
    workspaceId?: string;
    projectId?: string;
    pageId?: string;
  }): Promise<string | null> {
    if (scope.workspaceId) {
      const ws = await this.resolveWorkspace(scope.workspaceId);
      return ws?.id || null;
    }
    if (scope.projectId) {
      const project = await this.fileRepo.findProjectScope(scope.projectId);
      return project?.workspaceId || null;
    }
    if (scope.pageId) {
      const page = await this.fileRepo.findPageScope(scope.pageId);
      return page?.workspaceId || null;
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
    const cleanName = dto.filename.replace(/[^a-zA-Z0-9.-]/g, '_');
    const key = `uploads/${Date.now()}-${cleanName}`;
    const contentType =
      dto.contentType || dto.mimeType || 'application/octet-stream';

    const presigned = await this.r2Service.getPresignedUploadUrl(
      key,
      contentType,
      3600,
    );

    return {
      signedUrl: presigned.signedUrl,
      path: presigned.path,
      url: presigned.url,
    };
  }

  async uploadMultipart(req: FastifyRequest, authorId: string) {
    const isMultipart = req.isMultipart();
    if (!isMultipart) {
      throw new BadRequestException('Content-Type must be multipart/form-data');
    }

    const parts = req.parts();
    let buffer: Buffer | null = null;
    let filename = 'unnamed-file';
    let mimeType = 'application/octet-stream';
    const fields: Record<string, unknown> = {};

    for await (const part of parts) {
      if (part.type === 'file') {
        filename = part.filename;
        mimeType = part.mimetype;
        buffer = await part.toBuffer();
      } else {
        fields[part.fieldname] = part.value;
      }
    }

    if (!buffer) {
      throw new BadRequestException(
        'No file payload found in multipart request',
      );
    }

    const getFieldValue = (val: unknown): string | undefined => {
      if (!val) return undefined;
      if (typeof val === 'string') return val;
      if (typeof val === 'object' && 'value' in val) {
        return val.value as string;
      }
      return undefined;
    };

    const workspaceId = getFieldValue(fields.workspaceId);
    const projectId = getFieldValue(fields.projectId);
    const pageId = getFieldValue(fields.pageId);
    const source = getFieldValue(fields.source) || getFieldValue(fields.module);
    const skipFileRecord = getFieldValue(fields.skipFileRecord) === 'true';

    return this.uploadR2Buffer(authorId, filename, buffer, mimeType, {
      workspaceId,
      projectId,
      pageId,
      source,
      skipFileRecord,
    });
  }

  async uploadMultipartStream(req: FastifyRequest, authorId: string) {
    return this.uploadMultipart(req, authorId);
  }

  async uploadR2Buffer(
    userId: string,
    filename: string,
    buffer: Buffer,
    mimeType = 'application/octet-stream',
    scope: {
      workspaceId?: string;
      projectId?: string;
      pageId?: string;
      source?: string;
      skipFileRecord?: boolean;
      createRecord?: boolean;
    } = {},
  ) {
    const cleanName = filename.replace(/[^a-zA-Z0-9.-]/g, '_');
    const key = `uploads/${Date.now()}-${cleanName}`;
    const uploadRes = await this.r2Service.uploadBuffer(key, buffer, mimeType);

    // Pure binary upload transport if explicitly requested
    if (scope.skipFileRecord) {
      return {
        file: null,
        url: uploadRes.url,
        path: uploadRes.path,
      };
    }

    const resolvedWorkspaceId = await this.resolveWorkspaceId(scope);

    const isLibrary =
      scope.source?.toLowerCase() === 'library' ||
      scope.source?.toLowerCase() === 'paper';

    const linkedToType = scope.pageId
      ? 'Page'
      : scope.projectId
        ? 'Project'
        : isLibrary
          ? 'Library'
          : resolvedWorkspaceId
            ? 'Workspace'
            : null;
    const linkedToId =
      scope.pageId || scope.projectId || resolvedWorkspaceId || null;

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
          metaData: scope.source ? { source: scope.source } : {},
          authorId: userId,
          workspaceId: resolvedWorkspaceId,
          linkedToType,
          linkedToId,
        });

        if (resolvedWorkspaceId && file?.id) {
          await this.invalidateStorageCache(resolvedWorkspaceId, file.id);
        }

        if (file && linkedToType !== 'Library') {
          this.eventEmitter?.emit(
            'file.created',
            new DomainActivityEvent({
              entityType: 'file' as unknown as EntityType,
              entityId: file.id,
              verb: 'uploaded',
              actorId: userId,
              workspaceId: resolvedWorkspaceId || '',
              projectId: scope.projectId || undefined,
            }),
          );
        }
      }
    } catch (dbErr) {
      this.logger.warn(
        `Failed to create database record for uploaded file: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`,
      );
    }

    return {
      file: file ? this.formatFile(file) : null,
      id: file?.id,
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
    const linkedToId = scope.pageId || scope.projectId || workspaceId || null;
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

    await this.invalidateStorageCache(workspaceId, file.id);

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
    const linkedToId = scope.pageId || scope.projectId || workspaceId || null;
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

    await this.invalidateStorageCache(workspaceId, folder.id);

    return { folder: this.formatFile(folder) };
  }

  async getFile(fileId: string, userId: string) {
    const cacheKey = STORAGE_REDIS_KEYS.file(fileId);
    if (this.cache) {
      const cached = await this.cache.get<any>(cacheKey);
      if (cached) return { file: cached };
    }

    const file = await this.assertCanAccessFile(userId, fileId, 'read');
    const formatted = this.formatFile(file);

    if (this.cache) {
      await this.cache.set(cacheKey, formatted, 1800);
    }

    return { file: formatted };
  }

  async getFileContentStream(
    fileId: string,
    userId: string,
    rangeHeader?: string,
  ) {
    const file = await this.assertCanAccessFile(userId, fileId, 'read');

    if (file.trashedAt !== null || (file as any).isTrash) {
      throw new NotFoundException(`File ${fileId} is in trash`);
    }

    let storageKey = '';
    const R2_PREFIX = '/api/files/r2/';
    if (file.url && file.url.startsWith(R2_PREFIX)) {
      storageKey = file.url.slice(R2_PREFIX.length).trim();
    } else if (
      file.url &&
      !file.url.startsWith('http') &&
      !file.url.startsWith('/api/files/')
    ) {
      storageKey = file.url.trim();
    } else if ((file.metaData as any)?.storageKey) {
      storageKey = (file.metaData as any).storageKey;
    } else if (file.url) {
      storageKey = file.url.replace(/^\/+/, '');
    }

    if (!storageKey) {
      throw new NotFoundException(
        `Storage object key not found for file ${fileId}`,
      );
    }

    const totalSize = file.size ?? 0;
    let validatedRange: {
      start: number;
      end: number;
      length: number;
      contentRange: string;
    } | null = null;

    if (rangeHeader) {
      const rangeResult = parseByteRange(rangeHeader, totalSize);
      if (!rangeResult.success) {
        throw new HttpException(
          {
            statusCode: HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE,
            message: 'Requested range not satisfiable',
            contentRange: rangeResult.contentRange,
          },
          HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE,
        );
      }
      validatedRange = rangeResult;
    }

    const key = decodeURIComponent(storageKey);
    const rangeParam = validatedRange
      ? `bytes=${validatedRange.start}-${validatedRange.end}`
      : undefined;

    let output: any = null;
    try {
      output = await this.r2Service.getObjectStream(key, rangeParam);
    } catch (err: any) {
      if (
        err?.name === 'NoSuchKey' ||
        err?.$metadata?.httpStatusCode === 404 ||
        err?.code === 'ENOENT'
      ) {
        throw new NotFoundException(
          `File content not found in storage: ${fileId}`,
        );
      }
      this.logger.error(
        `Storage service error for file ${fileId} (key: ${key}): ${err?.message || err}`,
      );
      throw new ServiceUnavailableException(
        `Storage service unavailable for file ${fileId}`,
      );
    }

    if (!output?.Body) {
      throw new NotFoundException(
        `File content stream not found for file ${fileId}`,
      );
    }

    let contentType =
      file.mimeType || output.ContentType || 'application/octet-stream';
    if (contentType === 'application/octet-stream') {
      const lower = (file.filename || key).toLowerCase();
      if (lower.endsWith('.pdf')) contentType = 'application/pdf';
      else if (lower.endsWith('.png')) contentType = 'image/png';
      else if (lower.endsWith('.jpg') || lower.endsWith('.jpeg'))
        contentType = 'image/jpeg';
      else if (lower.endsWith('.svg')) contentType = 'image/svg+xml';
      else if (lower.endsWith('.webp')) contentType = 'image/webp';
      else if (lower.endsWith('.gif')) contentType = 'image/gif';
      else if (lower.endsWith('.mp4')) contentType = 'video/mp4';
      else if (lower.endsWith('.mp3')) contentType = 'audio/mpeg';
      else if (lower.endsWith('.json')) contentType = 'application/json';
      else if (lower.endsWith('.txt')) contentType = 'text/plain';
    }

    return {
      stream: output.Body,
      contentType,
      contentLength: validatedRange
        ? validatedRange.length
        : (output.ContentLength ?? file.size),
      contentRange: validatedRange ? validatedRange.contentRange : undefined,
      filename: file.filename || 'document.pdf',
      statusCode: validatedRange ? HttpStatus.PARTIAL_CONTENT : HttpStatus.OK,
    };
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
    const existing = await this.assertCanAccessFile(userId, fileId, 'write');
    const file = await this.fileRepo.updateFile(fileId, {
      ...(dto.filename !== undefined && { filename: dto.filename }),
      ...(dto.starred !== undefined && { starred: dto.starred }),
      ...(dto.parentId !== undefined && { parentId: dto.parentId }),
      ...(dto.metaData !== undefined && {
        metaData: dto.metaData as Prisma.InputJsonValue,
      }),
    });

    await this.invalidateStorageCache(existing.workspaceId, fileId);

    return { file: this.formatFile(file) };
  }

  async deleteFile(fileId: string, userId: string) {
    const file = await this.assertCanAccessFile(userId, fileId, 'write');
    await this.fileRepo.trashFile(fileId);
    await this.invalidateStorageCache(file.workspaceId, fileId);
    return { message: 'File moved to trash' };
  }

  async batchDeleteFiles(ids: string[]) {
    if (!ids || ids.length === 0)
      return { message: 'No files provided', count: 0 };
    const safeFiles = await this.fileRepo.findFiles({
      id: { in: ids },
      NOT: NON_WORKSPACE_STORAGE_EXCLUSION,
    });
    const safeIds = safeFiles.map((f) => f.id);
    if (safeIds.length === 0) {
      return { message: 'No valid workspace files to delete', count: 0 };
    }
    const res = await this.fileRepo.batchUpdateFiles(safeIds, {
      trashedAt: new Date(),
    });
    return { message: 'Files moved to trash', count: res.count };
  }

  async restoreFile(fileId: string, userId: string) {
    const file = await this.assertCanAccessFile(userId, fileId, 'write');
    await this.fileRepo.restoreFile(fileId);
    await this.invalidateStorageCache(file.workspaceId, fileId);
    return { message: 'File restored successfully' };
  }

  async batchRestoreFiles(ids: string[]) {
    if (!ids || ids.length === 0)
      return { message: 'No files provided', count: 0 };
    const safeFiles = await this.fileRepo.findFiles({
      id: { in: ids },
      NOT: NON_WORKSPACE_STORAGE_EXCLUSION,
    });
    const safeIds = safeFiles.map((f) => f.id);
    if (safeIds.length === 0) {
      return { message: 'No valid workspace files to restore', count: 0 };
    }
    const res = await this.fileRepo.batchUpdateFiles(safeIds, {
      trashedAt: null,
    });
    return { message: 'Files restored successfully', count: res.count };
  }

  async permanentlyDeleteFile(fileId: string, userId: string) {
    const file = await this.assertCanAccessFile(userId, fileId, 'write');

    const deletePromises: Promise<unknown>[] = [
      this.fileRepo.deleteFile(fileId),
    ];
    if (file.url && file.url.includes('/api/files/r2/')) {
      const key = file.url.replace('/api/files/r2/', '');
      deletePromises.push(this.r2Service.deleteObject(key));
    }
    await Promise.all(deletePromises);
    await this.invalidateStorageCache(file.workspaceId, fileId);

    return { message: 'File permanently deleted' };
  }

  async batchPermanentlyDeleteFiles(ids: string[]) {
    if (!ids || ids.length === 0)
      return { message: 'No files provided', count: 0 };
    const safeFiles = await this.fileRepo.findFiles({
      id: { in: ids },
      NOT: NON_WORKSPACE_STORAGE_EXCLUSION,
    });
    const safeIds = safeFiles.map((f) => f.id);
    if (safeIds.length === 0) {
      return {
        message: 'No valid workspace files to permanently delete',
        count: 0,
      };
    }

    const deletePromises: Promise<unknown>[] = [
      this.fileRepo.batchDeleteFiles(safeIds),
    ];

    for (const file of safeFiles) {
      if (file.url && file.url.includes('/api/files/r2/')) {
        const key = file.url.replace('/api/files/r2/', '');
        deletePromises.push(this.r2Service.deleteObject(key));
      }
    }

    await Promise.all(deletePromises);
    return { message: 'Files permanently deleted', count: safeFiles.length };
  }

  async toggleStar(fileId: string, userId: string) {
    const file = await this.assertCanAccessFile(userId, fileId, 'write');

    const updated = await this.fileRepo.updateFile(fileId, {
      starred: !file.starred,
    });

    await this.invalidateStorageCache(file.workspaceId, fileId);

    return { file: this.formatFile(updated) };
  }

  async batchToggleStar(ids: string[], starred: boolean) {
    if (!ids || ids.length === 0)
      return { message: 'No files provided', count: 0 };
    const safeFiles = await this.fileRepo.findFiles({
      id: { in: ids },
      NOT: NON_WORKSPACE_STORAGE_EXCLUSION,
    });
    const safeIds = safeFiles.map((f) => f.id);
    if (safeIds.length === 0) {
      return { message: 'No valid workspace files to update', count: 0 };
    }
    const res = await this.fileRepo.batchUpdateFiles(safeIds, {
      starred,
    });
    return {
      message: `Files ${starred ? 'starred' : 'unstarred'} successfully`,
      count: res.count,
    };
  }

  async renameFile(fileId: string, userId: string, filename: string) {
    const file = await this.assertCanAccessFile(userId, fileId, 'write');
    const updated = await this.fileRepo.updateFile(fileId, {
      filename,
    });
    await this.invalidateStorageCache(file.workspaceId, fileId);
    return { file: this.formatFile(updated) };
  }

  async moveFile(fileId: string, userId: string, parentId?: string) {
    const file = await this.assertCanAccessFile(userId, fileId, 'write');
    if (file.isFolder && parentId) {
      await this.validateNoCircularFolder(fileId, parentId);
    }
    const updated = await this.fileRepo.updateFile(fileId, {
      parentId: parentId || null,
    });
    await this.invalidateStorageCache(file.workspaceId, fileId);
    return { file: this.formatFile(updated) };
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

  async getStorageUsage(workspaceParam: string) {
    const workspaceId =
      (await this.resolveWorkspaceId({ workspaceId: workspaceParam })) ||
      workspaceParam;
    const cacheKey = STORAGE_REDIS_KEYS.quota(workspaceId);

    if (this.cache) {
      const cached = await this.cache.get<number>(cacheKey);
      if (cached !== null && cached !== undefined) {
        return { totalBytes: cached };
      }
    }

    const usage =
      await this.fileRepo.calculateWorkspaceStorageUsage(workspaceId);

    if (this.cache) {
      await this.cache.set(cacheKey, usage, 1800);
    }

    return { totalBytes: usage };
  }

  // ── Scoped Queries ──────────────────────────────────────────────────────────

  async getFiles(scope: {
    workspaceId?: string;
    projectId?: string;
    pageId?: string;
    parentId?: string;
  }) {
    const workspaceId = await this.resolveWorkspaceId(scope);
    const targetParentId =
      scope.parentId === 'null' ||
      scope.parentId === 'undefined' ||
      scope.parentId === ''
        ? null
        : scope.parentId;

    const cacheKey = workspaceId
      ? STORAGE_REDIS_KEYS.folderTree(workspaceId, targetParentId)
      : null;

    if (this.cache && cacheKey && !scope.pageId && !scope.projectId) {
      const cached = await this.cache.get<any>(cacheKey);
      if (cached) return cached;
    }

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
      where.NOT = NON_WORKSPACE_STORAGE_EXCLUSION;
    }

    if (scope.parentId !== undefined) {
      where.parentId = targetParentId;
    }

    const files = await this.fileRepo.findFiles(where, [
      { isFolder: 'desc' },
      { filename: 'asc' },
    ]);

    const result = { files: files.map((f) => this.formatFile(f)) };

    if (this.cache && cacheKey && !scope.pageId && !scope.projectId) {
      await this.cache.set(cacheKey, result, 3600);
    }

    return result;
  }

  async getHomeFiles(workspaceParam: string) {
    const workspaceId =
      (await this.resolveWorkspaceId({ workspaceId: workspaceParam })) ||
      workspaceParam;
    const files = await this.fileRepo.findFiles(
      {
        workspaceId,
        trashedAt: null,
        parentId: null,
        NOT: NON_WORKSPACE_STORAGE_EXCLUSION,
      },
      [{ isFolder: 'desc' }, { createdAt: 'desc' }],
      50,
    );

    return { files: files.map((f) => this.formatFile(f)) };
  }

  async getMyFiles(
    userId: string,
    workspaceParam?: string,
    projectId?: string,
  ) {
    const workspaceId = workspaceParam
      ? (await this.resolveWorkspaceId({ workspaceId: workspaceParam })) ||
        workspaceParam
      : undefined;
    const files = await this.fileRepo.findFiles(
      {
        authorId: userId,
        trashedAt: null,
        ...(workspaceId &&
          !projectId && {
            workspaceId,
            NOT: NON_WORKSPACE_STORAGE_EXCLUSION,
          }),
        ...(projectId && { linkedToId: projectId, linkedToType: 'Project' }),
      },
      [{ createdAt: 'desc' }],
    );

    return { files: files.map((f) => this.formatFile(f)) };
  }

  async getStarredFiles(workspaceParam?: string, projectId?: string) {
    const workspaceId = workspaceParam
      ? (await this.resolveWorkspaceId({ workspaceId: workspaceParam })) ||
        workspaceParam
      : undefined;
    const files = await this.fileRepo.findFiles(
      {
        starred: true,
        trashedAt: null,
        ...(workspaceId &&
          !projectId && {
            workspaceId,
            NOT: NON_WORKSPACE_STORAGE_EXCLUSION,
          }),
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
      ? (await this.resolveWorkspaceId({ workspaceId: workspaceParam })) ||
        workspaceParam
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
        if (
          ['Project', 'Page', 'Library', 'Paper'].includes(
            f.linkedToType || '',
          ) ||
          (f.metaData as any)?.source === 'library' ||
          (f.metaData as any)?.source === 'paper' ||
          (Array.isArray((f as any).attachments) &&
            (f as any).attachments.length > 0)
        ) {
          return false;
        }
        return true;
      });

    return { files: files.map((f) => this.formatFile(f)) };
  }

  async getTrashedFiles(workspaceParam?: string, projectId?: string) {
    const workspaceId = workspaceParam
      ? (await this.resolveWorkspaceId({ workspaceId: workspaceParam })) ||
        workspaceParam
      : undefined;
    const files = await this.fileRepo.findFiles(
      {
        trashedAt: { not: null },
        ...(workspaceId &&
          !projectId && {
            workspaceId,
            NOT: NON_WORKSPACE_STORAGE_EXCLUSION,
          }),
        ...(projectId && { linkedToId: projectId, linkedToType: 'Project' }),
      },
      [{ trashedAt: 'desc' }],
    );

    return { files: files.map((f) => this.formatFile(f)) };
  }
}
