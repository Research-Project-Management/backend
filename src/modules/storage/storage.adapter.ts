import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import {
  IStoragePort,
  ReadOwnedFileInput,
  ReadOwnedFileOutput,
  LinkFileInput,
  UploadFileInput,
  UploadFileOutput,
  getFileContentPath,
} from './storage.port';
import { PrismaService } from '@/core/database/prisma.service';
import { R2Service } from './r2/r2.service';
import {
  assertFileNotTrashed,
  resolveFileStorageKey,
} from './file/utils/storage-key.util';
import {
  validateMagicBytes,
  sanitizeFilename,
} from './file/utils/file-validator.util';
import { Readable } from 'stream';

@Injectable()
export class StorageAdapter implements IStoragePort {
  private readonly logger = new Logger(StorageAdapter.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly r2Service: R2Service,
  ) {}

  async readOwnedFile(input: ReadOwnedFileInput): Promise<ReadOwnedFileOutput> {
    const { fileId, projectId, userId } = input;

    if (!fileId || typeof fileId !== 'string') {
      throw new NotFoundException('fileId is required');
    }

    const file = await this.prisma.file.findUnique({
      where: { id: fileId },
      include: {
        sharedWith: true,
      },
    });

    if (!file) {
      throw new NotFoundException(`File ${fileId} not found`);
    }

    // Security: Enforce ownership & authorization check (BOLA/IDOR prevention)
    if (userId) {
      const isOwner = file.authorId === userId;
      const isShared = (file as any).sharedWith?.some(
        (share: any) => share.userId === userId,
      );
      const isProjectFile =
        projectId &&
        file.linkedToType === 'Project' &&
        file.linkedToId === projectId;
      const isLibraryFile =
        file.linkedToType === 'Library' || file.linkedToType === 'Paper';

      if (!isOwner && !isShared && !isProjectFile && !isLibraryFile) {
        throw new ForbiddenException(
          'Access denied: You do not have permission to read this file',
        );
      }
    }

    assertFileNotTrashed(file, fileId);
    const storageKey = resolveFileStorageKey(file, fileId);

    try {
      const response = await this.r2Service.getObjectStream(storageKey);
      const stream = response?.Body as Readable;
      if (!stream) {
        throw new NotFoundException(
          `Empty stream returned for storage object ${storageKey}`,
        );
      }

      const chunks: Buffer[] = [];
      let totalBytes = 0;
      const MAX_SAFE_BUFFER_BYTES = 100 * 1024 * 1024; // 100MB limit to prevent Heap Exhaustion

      for await (const chunk of stream) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buf.length;
        if (totalBytes > MAX_SAFE_BUFFER_BYTES) {
          throw new BadRequestException(
            'File size exceeds safe maximum in-memory buffer limit (100MB)',
          );
        }
        chunks.push(buf);
      }
      const buffer = Buffer.concat(chunks);
      const contentUrl = getFileContentPath(file.id);

      return {
        fileId: file.id,
        filename: file.filename || (file as any).name || 'document.pdf',
        mimeType: file.mimeType || 'application/pdf',
        size: file.size ?? buffer.length,
        storageKey,
        contentUrl,
        buffer,
      };
    } catch (err: any) {
      if (
        err instanceof NotFoundException ||
        err instanceof ForbiddenException
      ) {
        throw err;
      }

      const isNotFound =
        err?.name === 'NoSuchKey' ||
        err?.name === 'NotFound' ||
        err?.code === 'ENOENT' ||
        err?.statusCode === 404 ||
        err?.$metadata?.httpStatusCode === 404 ||
        err?.message?.includes('not found') ||
        err?.message?.includes('ENOENT');

      if (isNotFound) {
        throw new NotFoundException(
          `Storage object not found for file ${fileId}: ${storageKey}`,
        );
      }

      this.logger.error(
        `Failed to read file object from storage for fileId=${fileId}: ${err.message}`,
      );
      throw new InternalServerErrorException(
        `Storage read failure for file ${fileId}: ${err.message}`,
      );
    }
  }

  async linkFile(input: LinkFileInput): Promise<void> {
    if (!input.fileId) return;
    await this.prisma.file.updateMany({
      where: { id: input.fileId },
      data: {
        linkedToType: input.linkedToType,
        linkedToId: input.linkedToId,
      },
    });
  }

  async uploadFile(input: UploadFileInput): Promise<UploadFileOutput> {
    const { projectId, userId, filename, buffer, mimeType, source, parentId } =
      input;

    // Security: Validate file signatures (magic bytes) and sanitize filename
    validateMagicBytes(buffer, mimeType, filename);
    const cleanName = sanitizeFilename(filename);

    const key = projectId
      ? `projects/${projectId}/uploads/${Date.now()}-${cleanName}`
      : `users/${userId}/uploads/${Date.now()}-${cleanName}`;
    const uploadRes = await this.r2Service.uploadBuffer(key, buffer, mimeType);

    const isLibrary =
      source?.toLowerCase() === 'library' || source?.toLowerCase() === 'paper';

    const linkedToType = isLibrary
      ? 'Library'
      : projectId
        ? 'Project'
        : 'Personal';
    const linkedToId = projectId || userId || null;

    const file = await this.prisma.file.create({
      data: {
        filename,
        isFolder: false,
        size: buffer.length,
        mimeType: mimeType || 'application/octet-stream',
        url: uploadRes.url,
        thumbnail: null,
        parentId: parentId || null,
        metaData: source ? { source } : {},
        authorId: userId,
        linkedToType,
        linkedToId,
      },
    });

    return {
      fileId: file.id,
      url: uploadRes.url,
      path: uploadRes.path,
      filename: file.filename,
      size: file.size ?? 0,
      mimeType: file.mimeType || mimeType,
    };
  }

  async uploadBuffer(
    key: string,
    buffer: Buffer,
    contentType?: string,
  ): Promise<{ path: string; url: string }> {
    return this.r2Service.uploadBuffer(key, buffer, contentType);
  }
}
