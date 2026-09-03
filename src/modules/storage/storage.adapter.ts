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
  getFileContentPath,
} from './storage.port';
import { PrismaService } from '@/core/database/prisma.service';
import { R2Service } from './r2/r2.service';
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
          where: {
            OR: [
              { id: workspaceId },
              { slug: workspaceId },
              { url: workspaceId },
            ],
            deletedAt: null,
          },
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
        `Empty storage object key for file ${fileId}`,
      );
    }

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
}
