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
import '@fastify/multipart';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { FileRepository } from './file.repository';
import { R2Service } from '../r2/r2.service';
import { parseByteRange } from './utils/range.utils';
import {
  assertFileNotTrashed,
  resolveFileStorageKey,
} from './utils/storage-key.util';
import { PrismaService } from '@/core/database/prisma.service';
import { isUUID as isUuid } from 'class-validator';
import { Prisma, EntityType } from '@prisma/client';
import { DomainActivityEvent } from '@/modules/activity/events/activity.events';
import { RedisCacheService } from '@/core/cache/redis.service';
import { STORAGE_REDIS_KEYS } from './constants/redis-keys.constant';
import {
  PresignDto,
  UploadFileDto,
  CreateFolderDto,
  UpdateFileDto,
  ShareFileDto,
} from './dto/file.dto';
import { FileWithAuthor } from './types/storage-repository.interface';
import {
  validateMagicBytes,
  isBlockedExtension,
  sanitizeFilename,
} from './utils/file-validator.util';

export type FormattedFile<
  T extends {
    id: string;
    parentId?: string | null;
  },
> = T & {
  parent?: string | null;
};

export const NON_DRIVE_STORAGE_EXCLUSION: Prisma.FileWhereInput['NOT'] = [
  { linkedToType: { in: ['Library', 'Paper'] } },
  { metaData: { path: ['source'], equals: 'library' } },
  { metaData: { path: ['source'], equals: 'paper' } },
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
          OR: [
            { metaData: { path: ['source'], equals: 'library' } },
            { metaData: { path: ['source'], equals: 'paper' } },
          ],
          NOT: { linkedToType: 'Library' },
        },
        data: {
          linkedToType: 'Library',
        },
      });
      if (updated.count > 0) {
        this.logger.log(
          `[Remediation] Isolated ${updated.count} legacy library files to Library storage type`,
        );
      }
    } catch (err) {
      this.logger.debug?.(
        `[Remediation] Legacy library file isolation check bypassed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async invalidateStorageCache(
    scopeId?: string | null,
    fileId?: string,
  ) {
    if (!this.cache) return;
    const promises: Promise<any>[] = [];
    if (scopeId) {
      promises.push(this.cache.delPattern(`flux:storage:tree:${scopeId}:*`));
      promises.push(this.cache.del(STORAGE_REDIS_KEYS.quota(scopeId)));
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
    scope: { pageId?: string },
  ): Promise<void> {
    if (scope.pageId) {
      const page = await this.fileRepo.findPageScope(scope.pageId);
      if (!page) throw new NotFoundException('Page not found');
      return;
    }

    // Personal / Global scope: authenticated user can upload their own files
    return;
  }

  public async assertCanAccessFile(
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

      if (!isLibraryFile && (this.prisma as any)?.attachment) {
        const attCount = await (this.prisma as any).attachment.count({
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

    // 1. Author has full access
    if (file.authorId === userId) return file;

    // 2. Direct user share
    const directShare = file.sharedWith?.find((s: any) => s.userId === userId);
    if (directShare) {
      if (required === 'write' && directShare.permission !== 'edit') {
        throw new ForbiddenException('You only have view access to this file');
      }
      return file;
    }

    // 3. Project-linked file
    if (file.linkedToType === 'Project' && file.linkedToId) {
      const project = await this.fileRepo.findProjectScope(file.linkedToId);
      if (project && project.createdById === userId) {
        return file;
      }
      const role = await this.fileRepo.findProjectMemberRole(
        file.linkedToId,
        userId,
      );
      if (role) {
        if (
          required === 'write' &&
          (role === 'viewer' || role === 'commenter')
        ) {
          throw new ForbiddenException(
            'Viewers and commenters cannot modify files in this project',
          );
        }
        return file;
      }
    }

    // 4. Page-linked file
    if (file.linkedToType === 'Page' && file.linkedToId) {
      const page = await this.fileRepo.findPageScope(file.linkedToId);
      if (page?.projectId) {
        const project = await this.fileRepo.findProjectScope(page.projectId);
        if (project && project.createdById === userId) {
          return file;
        }
        const role = await this.fileRepo.findProjectMemberRole(
          page.projectId,
          userId,
        );
        if (role) {
          if (
            required === 'write' &&
            (role === 'viewer' || role === 'commenter')
          ) {
            throw new ForbiddenException(
              'Viewers and commenters cannot modify files in this page',
            );
          }
          return file;
        }
      }
    }

    throw new ForbiddenException('You do not have access to this file');
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

  async presign(userId: string, dto: PresignDto) {
    if (!userId) {
      throw new ForbiddenException('User is not authenticated');
    }

    // 1. Authorize scope before issuing presigned upload URL
    await this.assertCanWriteScope(userId, {
      pageId: dto.pageId,
    });

    // 2. Validate size, extension & mimeType
    if (dto.size && dto.size > 100 * 1024 * 1024) {
      throw new BadRequestException('File size exceeds maximum 100MB limit');
    }

    if (isBlockedExtension(dto.filename)) {
      throw new BadRequestException(
        'Disallowed file extension: Executables and scripts are prohibited for security reasons',
      );
    }

    const contentType =
      dto.contentType || dto.mimeType || 'application/octet-stream';
    const lowerType = contentType.toLowerCase();
    const disallowedTypes = [
      'text/html',
      'application/x-msdownload',
      'application/x-sh',
      'application/javascript',
    ];
    if (disallowedTypes.includes(lowerType)) {
      throw new BadRequestException(
        `Content type ${contentType} is not permitted for upload`,
      );
    }

    const cleanName = sanitizeFilename(dto.filename);
    const key = `users/${userId}/uploads/${Date.now()}-${cleanName}`;

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
    const fastifyReq = req as any;
    const isMultipart = Boolean(fastifyReq.isMultipart?.());
    if (!isMultipart) {
      throw new BadRequestException('Content-Type must be multipart/form-data');
    }

    const parts = fastifyReq.parts();
    let buffer: Buffer | null = null;
    let filename = 'unnamed-file';
    let mimeType = 'application/octet-stream';
    const fields: Record<string, unknown> = {};

    for await (const part of parts) {
      if (part.type === 'file') {
        filename = sanitizeFilename(part.filename || 'unnamed-file');
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

    // Security: Verify file signature (magic bytes) against MIME type and block dangerous extensions
    validateMagicBytes(buffer, mimeType, filename);

    const getFieldValue = (val: unknown): string | undefined => {
      if (!val) return undefined;
      if (typeof val === 'string') return val;
      if (typeof val === 'object' && 'value' in val) {
        return val.value as string;
      }
      return undefined;
    };

    const projectId = getFieldValue(fields.projectId);
    const pageId = getFieldValue(fields.pageId);
    const source = getFieldValue(fields.source) || getFieldValue(fields.module);

    // Pre-authorize scope before performing any upload to R2
    await this.assertCanWriteScope(authorId, {
      pageId,
    });

    return this.uploadR2Buffer(authorId, filename, buffer, mimeType, {
      pageId,
      source,
      skipFileRecord: false, // Disallow skipping file record from public API
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
      pageId?: string;
      source?: string;
      skipFileRecord?: boolean;
      createRecord?: boolean;
    } = {},
  ) {
    // Security: Enforce binary signature validation
    validateMagicBytes(buffer, mimeType, filename);

    const cleanName = sanitizeFilename(filename);
    const key = `users/${userId}/uploads/${Date.now()}-${cleanName}`;
    const uploadRes = await this.r2Service.uploadBuffer(key, buffer, mimeType);

    // Pure binary upload transport if explicitly requested
    if (scope.skipFileRecord) {
      return {
        file: null,
        url: uploadRes.url,
        path: uploadRes.path,
      };
    }

    const isLibrary =
      scope.source?.toLowerCase() === 'library' ||
      scope.source?.toLowerCase() === 'paper';

    const linkedToType = scope.pageId
      ? 'Page'
      : isLibrary
        ? 'Library'
        : 'Personal';
    const linkedToId = scope.pageId || userId || null;

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
          linkedToType,
          linkedToId,
        });

        if (linkedToId && file?.id) {
          await this.invalidateStorageCache(linkedToId, file.id);
        }

        if (file && linkedToType !== 'Library') {
          this.eventEmitter?.emit(
            'file.created',
            new DomainActivityEvent({
              entityType: 'file' as unknown as EntityType,
              entityId: file.id,
              verb: 'uploaded',
              actorId: userId,
            }),
          );
        }
      }
    } catch (dbErr) {
      this.logger.error(
        `Failed to create database record for uploaded file: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}. Cleaning up R2 object ${key}...`,
      );
      await this.r2Service.deleteObject(key).catch(() => {});
      throw dbErr;
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

  private async resolveScopeContext(
    userId: string,
    scope: { pageId?: string } = {},
    parentIdDto?: string,
  ) {
    await this.assertCanWriteScope(userId, scope);
    let linkedToType: string = 'Personal';
    let linkedToId: string = userId;

    if (scope.pageId) {
      linkedToType = 'Page';
      linkedToId = scope.pageId;
    }

    const parentId =
      parentIdDto === 'null' || parentIdDto === 'undefined' || !parentIdDto
        ? null
        : parentIdDto;

    return { linkedToType, linkedToId, parentId };
  }

  async upload(
    userId: string,
    scope: { pageId?: string } = {},
    dto: UploadFileDto,
  ) {
    const { linkedToType, linkedToId, parentId } =
      await this.resolveScopeContext(userId, scope, dto.parentId);

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
      linkedToType,
      linkedToId,
    });

    await this.invalidateStorageCache(linkedToId, file.id);

    return { file: this.formatFile(file) };
  }

  async createFolder(
    userId: string,
    scope: { pageId?: string } = {},
    dto: CreateFolderDto,
  ) {
    const { linkedToType, linkedToId, parentId } =
      await this.resolveScopeContext(userId, scope, dto.parentId);

    const folder = await this.fileRepo.createFile({
      filename: dto.filename || dto.name || 'Untitled Folder',
      isFolder: true,
      url: '',
      parentId,
      authorId: userId,
      linkedToType,
      linkedToId,
    });

    await this.invalidateStorageCache(linkedToId, folder.id);

    return { folder: this.formatFile(folder) };
  }

  async getFile(fileId: string, userId: string) {
    // Defense-in-depth: Authorize access before cache hit to prevent cache poisoning / cross-tenant leaks
    const file = await this.assertCanAccessFile(userId, fileId, 'read');
    const formatted = this.formatFile(file);

    const cacheKey = `${STORAGE_REDIS_KEYS.file(fileId)}:${file.linkedToId || 'global'}`;
    if (this.cache) {
      await this.cache.set(cacheKey, formatted, 1800);
    }

    return { file: formatted };
  }

  async findFileByKey(key: string) {
    return this.fileRepo.findFileByKey(key);
  }

  async getFileContentStream(
    fileId: string,
    userId: string,
    rangeHeader?: string,
  ) {
    const file = await this.assertCanAccessFile(userId, fileId, 'read');

    assertFileNotTrashed(file, fileId);
    const storageKey = resolveFileStorageKey(file, fileId);

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

  async getFolderPath(folderId: string, userId: string) {
    if (
      !folderId ||
      folderId === 'root' ||
      folderId === 'null' ||
      folderId === 'undefined' ||
      !isUuid(folderId)
    ) {
      return { path: [] };
    }

    if (!userId) {
      throw new ForbiddenException('User is not authenticated');
    }

    // Enforce read access to the target folder before traversing
    await this.assertCanAccessFile(userId, folderId, 'read');

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

    await this.invalidateStorageCache(
      existing.linkedToId || existing.authorId,
      fileId,
    );

    return { file: this.formatFile(file) };
  }

  async deleteFile(fileId: string, userId: string) {
    const file = await this.assertCanAccessFile(userId, fileId, 'write');
    await this.fileRepo.trashFile(fileId);
    await this.invalidateStorageCache(file.linkedToId || file.authorId, fileId);
    return { message: 'File moved to trash' };
  }

  /**
   * Helper to load all files in a batch, verify they all exist, belong to the same tenant,
   * and verify the current user has write permission for all of them.
   * If any file fails verification, the whole batch fails immediately.
   */
  private async assertCanWriteFilesBatch(
    userId: string,
    ids: string[],
  ): Promise<FileWithAuthor[]> {
    if (!userId) {
      throw new ForbiddenException('User is not authenticated');
    }
    if (!ids || ids.length === 0) {
      throw new BadRequestException('No files provided in batch request');
    }

    const uniqueIds = Array.from(new Set(ids));
    const files = await this.fileRepo.findFiles({
      id: { in: uniqueIds },
    });

    if (files.length !== uniqueIds.length) {
      throw new NotFoundException(
        'One or more files not found. Batch operation aborted.',
      );
    }

    for (const f of files) {
      await this.assertCanAccessFile(userId, f.id, 'write');
    }

    return files;
  }

  async batchDeleteFiles(ids: string[], userId: string) {
    const files = await this.assertCanWriteFilesBatch(userId, ids);
    const fileIds = files.map((f) => f.id);

    const res = await this.fileRepo.batchUpdateFiles(fileIds, {
      trashedAt: new Date(),
    });

    for (const f of files) {
      await this.invalidateStorageCache(f.linkedToId || f.authorId, f.id);
    }

    return { message: 'Files moved to trash', count: res.count };
  }

  async restoreFile(fileId: string, userId: string) {
    const file = await this.assertCanAccessFile(userId, fileId, 'write');
    await this.fileRepo.restoreFile(fileId);
    await this.invalidateStorageCache(file.linkedToId || file.authorId, fileId);
    return { message: 'File restored successfully' };
  }

  async batchRestoreFiles(ids: string[], userId: string) {
    const files = await this.assertCanWriteFilesBatch(userId, ids);
    const fileIds = files.map((f) => f.id);

    const res = await this.fileRepo.batchUpdateFiles(fileIds, {
      trashedAt: null,
    });

    for (const f of files) {
      await this.invalidateStorageCache(f.linkedToId || f.authorId, f.id);
    }

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
    await this.invalidateStorageCache(file.linkedToId || file.authorId, fileId);

    return { message: 'File permanently deleted' };
  }

  async batchPermanentlyDeleteFiles(ids: string[], userId: string) {
    const files = await this.assertCanWriteFilesBatch(userId, ids);
    const fileIds = files.map((f) => f.id);

    const deletePromises: Promise<unknown>[] = [
      this.fileRepo.batchDeleteFiles(fileIds),
    ];

    for (const file of files) {
      if (file.url && file.url.includes('/api/files/r2/')) {
        const key = file.url.replace('/api/files/r2/', '');
        deletePromises.push(this.r2Service.deleteObject(key));
      }
    }

    await Promise.all(deletePromises);

    for (const f of files) {
      await this.invalidateStorageCache(f.linkedToId || f.authorId, f.id);
    }

    return { message: 'Files permanently deleted', count: files.length };
  }

  async toggleStar(fileId: string, userId: string) {
    const file = await this.assertCanAccessFile(userId, fileId, 'write');

    const updated = await this.fileRepo.updateFile(fileId, {
      starred: !file.starred,
    });

    await this.invalidateStorageCache(file.linkedToId || file.authorId, fileId);

    return { file: this.formatFile(updated) };
  }

  async batchToggleStar(ids: string[], starred: boolean, userId: string) {
    const files = await this.assertCanWriteFilesBatch(userId, ids);
    const fileIds = files.map((f) => f.id);

    const res = await this.fileRepo.batchUpdateFiles(fileIds, {
      starred,
    });

    for (const f of files) {
      await this.invalidateStorageCache(f.linkedToId || f.authorId, f.id);
    }

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
    await this.invalidateStorageCache(file.linkedToId || file.authorId, fileId);
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
    await this.invalidateStorageCache(file.linkedToId || file.authorId, fileId);
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

  private formatStorageBytes(bytes: number): string {
    if (bytes <= 0) return '0 MB';
    const megabytes = bytes / (1024 * 1024);
    if (megabytes < 1024) {
      return `${megabytes.toFixed(1)} MB`;
    }
    const gigabytes = megabytes / 1024;
    return `${gigabytes.toFixed(2)} GB`;
  }

  async getUserStorageUsage(userId: string) {
    const cacheKey = STORAGE_REDIS_KEYS.quota(userId);
    let usage: number | null = null;

    if (this.cache) {
      usage = await this.cache.get<number>(cacheKey);
    }

    if (usage === null || usage === undefined) {
      usage = await this.fileRepo.calculateUserStorageUsage(userId);
      if (this.cache) {
        await this.cache.set(cacheKey, usage, 1800);
      }
    }

    const limitBytes = 5 * 1024 * 1024 * 1024; // 5 GB default quota
    const percentage = Number(
      Math.min(100, (usage / limitBytes) * 100).toFixed(1),
    );

    return {
      scope: 'personal' as const,
      totalBytes: usage,
      usedBytes: usage,
      limitBytes,
      usedFormatted: this.formatStorageBytes(usage),
      limitFormatted: '5 GB',
      percentage,
    };
  }

  async getProjectStorageUsage(projectId: string, userId: string) {
    const project = await this.fileRepo.getProjectWithHierarchy(projectId);
    if (!project) {
      throw new NotFoundException('Project not found');
    }

    // Authorization: User must be creator, member, or project must be public
    if (project.createdById !== userId && project.network !== 'public') {
      const role = await this.fileRepo.findProjectMemberRole(
        project.id,
        userId,
      );
      if (!role) {
        throw new ForbiddenException('You do not have access to this project');
      }
    }

    const owner = project.createdBy || {
      id: project.createdById,
      name: 'Chủ trì đề tài',
      email: '',
      avatar: null,
    };

    // Calculate Project Owner's total storage usage
    const ownerUsage = await this.fileRepo.calculateUserStorageUsage(owner.id);

    // Calculate this specific project's storage usage
    const projectUsage = await this.fileRepo.calculateProjectStorageUsage(
      project.id,
    );

    const limitBytes = 5 * 1024 * 1024 * 1024; // 5 GB
    const percentage = Number(
      Math.min(100, (ownerUsage / limitBytes) * 100).toFixed(1),
    );

    return {
      scope: 'project' as const,
      projectId: project.id,
      projectIdentifier: project.identifier,
      projectName: project.name,
      owner: {
        id: owner.id,
        name: owner.name || 'Chủ trì đề tài',
        email: owner.email || '',
        avatar: owner.avatar || null,
      },
      // Dung lượng được tính vào tài khoản Chủ trì đề tài (Project Owner)
      totalBytes: ownerUsage,
      usedBytes: ownerUsage,
      projectBytes: projectUsage,
      limitBytes,
      usedFormatted: this.formatStorageBytes(ownerUsage),
      projectFormatted: this.formatStorageBytes(projectUsage),
      limitFormatted: '5 GB',
      percentage,
      note: 'Dung lượng dự án được ghi nhận vào tài khoản Chủ trì đề tài (Project Owner)',
    };
  }

  // ── Scoped Queries ──────────────────────────────────────────────────────────

  async getFiles(
    scope: {
      pageId?: string;
      parentId?: string;
      userId?: string;
    } = {},
  ) {
    const contextId = scope.pageId || scope.userId || null;
    const targetParentId =
      scope.parentId === 'null' ||
      scope.parentId === 'undefined' ||
      scope.parentId === ''
        ? null
        : scope.parentId;

    const cacheKey = contextId
      ? STORAGE_REDIS_KEYS.folderTree(contextId, targetParentId)
      : null;

    if (this.cache && cacheKey) {
      const cached = await this.cache.get<any>(cacheKey);
      if (cached) return cached;
    }

    const where: Prisma.FileWhereInput = {
      trashedAt: null,
    };

    if (scope.pageId) {
      where.linkedToId = scope.pageId;
      where.linkedToType = 'Page';
    } else if (scope.userId) {
      where.authorId = scope.userId;
      where.NOT = NON_DRIVE_STORAGE_EXCLUSION;
    } else {
      where.NOT = NON_DRIVE_STORAGE_EXCLUSION;
    }

    if (scope.parentId !== undefined) {
      where.parentId = targetParentId;
    }

    const files = await this.fileRepo.findFiles(where, [
      { isFolder: 'desc' },
      { filename: 'asc' },
    ]);

    const result = { files: files.map((f) => this.formatFile(f)) };

    if (this.cache && cacheKey) {
      await this.cache.set(cacheKey, result, 3600);
    }

    return result;
  }

  async getMyFiles(userId: string) {
    const files = await this.fileRepo.findFiles(
      {
        authorId: userId,
        trashedAt: null,
        NOT: NON_DRIVE_STORAGE_EXCLUSION,
      },
      [{ isFolder: 'desc' }, { createdAt: 'desc' }],
    );

    return { files: files.map((f) => this.formatFile(f)) };
  }

  async getStarredFiles(userId: string) {
    const files = await this.fileRepo.findFiles(
      {
        authorId: userId,
        starred: true,
        trashedAt: null,
        NOT: NON_DRIVE_STORAGE_EXCLUSION,
      },
      [{ isFolder: 'desc' }, { updatedAt: 'desc' }],
    );

    return { files: files.map((f) => this.formatFile(f)) };
  }

  async getSharedFiles(userId: string) {
    const shares = await this.fileRepo.findFileShares(userId);

    const files = shares
      .map((s: any) => s.file)
      .filter((f: any) => {
        if (!f || f.trashedAt) return false;
        if (
          ['Library', 'Paper'].includes(f.linkedToType || '') ||
          f.metaData?.source === 'library' ||
          f.metaData?.source === 'paper' ||
          (Array.isArray(f.attachments) && f.attachments.length > 0)
        ) {
          return false;
        }
        return true;
      });

    return { files: files.map((f: any) => this.formatFile(f)) };
  }

  async getTrashedFiles(userId: string) {
    const files = await this.fileRepo.findFiles(
      {
        authorId: userId,
        trashedAt: { not: null },
        NOT: NON_DRIVE_STORAGE_EXCLUSION,
      },
      [{ trashedAt: 'desc' }],
    );

    return { files: files.map((f) => this.formatFile(f)) };
  }

  async linkFile(input: {
    fileId: string;
    linkedToType: string;
    linkedToId: string;
  }): Promise<void> {
    if (!input.fileId) return;
    await this.fileRepo.updateFile(input.fileId, {
      linkedToType: input.linkedToType,
      linkedToId: input.linkedToId,
    });
  }
}
