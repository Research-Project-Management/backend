import {
  Injectable,
  NotFoundException,
  ForbiddenException,
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
import { buildWorkspaceIdentifierWhere } from '@/core/utils/tenant.util';
import { R2Service } from './r2/r2.service';
import {
  assertFileNotTrashed,
  resolveFileStorageKey,
} from './file/utils/storage-key.util';
import { Readable } from 'stream';

@Injectable()
export class StorageAdapter implements IStoragePort {
  private readonly logger = new Logger(StorageAdapter.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly r2Service: R2Service,
  ) {}

  async readOwnedFile(input: ReadOwnedFileInput): Promise<ReadOwnedFileOutput> {
    const { workspaceId, fileId } = input;

    if (!fileId || typeof fileId !== 'string') {
      throw new NotFoundException('fileId is required');
    }

    const file = await this.prisma.file.findUnique({
      where: { id: fileId },
    });

    if (!file) {
      throw new NotFoundException(`File ${fileId} not found`);
    }

    if (file.workspaceId) {
      let matches = file.workspaceId === workspaceId;
      if (!matches && workspaceId) {
        const ws = await this.prisma.workspace.findFirst({
          where: buildWorkspaceIdentifierWhere(workspaceId),
          select: { id: true },
        });
        if (ws?.id === file.workspaceId) {
          matches = true;
        }
      }
      if (!matches) {
        throw new ForbiddenException(
          `Access denied: file ${fileId} does not belong to workspace ${workspaceId}`,
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
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
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
    const {
      workspaceId,
      userId,
      filename,
      buffer,
      mimeType,
      source,
      parentId,
    } = input;
    const cleanName = filename.replace(/[^a-zA-Z0-9.-]/g, '_');
    const key = `uploads/${Date.now()}-${cleanName}`;
    const uploadRes = await this.r2Service.uploadBuffer(key, buffer, mimeType);

    const isLibrary =
      source?.toLowerCase() === 'library' || source?.toLowerCase() === 'paper';

    const linkedToType = isLibrary
      ? 'Library'
      : workspaceId
        ? 'Workspace'
        : null;
    const linkedToId = workspaceId || null;

    let resolvedWorkspaceId = workspaceId;
    if (workspaceId) {
      const ws = await this.prisma.workspace.findFirst({
        where: buildWorkspaceIdentifierWhere(workspaceId),
        select: { id: true },
      });
      if (ws?.id) {
        resolvedWorkspaceId = ws.id;
      }
    }

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
        workspaceId: resolvedWorkspaceId,
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
