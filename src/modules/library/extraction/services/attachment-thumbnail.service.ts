import {
  Injectable,
  Logger,
  NotFoundException,
  Inject,
  Optional,
} from '@nestjs/common';
import { STORAGE_PORT, IStoragePort } from '@/modules/storage/storage.port';
import {
  STORAGE_DRIVER,
  STORAGE_NODE_REPOSITORY,
} from '@/modules/storage/storage.tokens';
import type { IStorageDriver } from '@/modules/storage/core';
import type { IStorageNodeRepository } from '@/modules/storage/drive';
import { PdfThumbnailService } from '@/modules/storage/worker';

@Injectable()
export class AttachmentThumbnailService {
  private readonly logger = new Logger(AttachmentThumbnailService.name);

  constructor(
    @Optional()
    @Inject(STORAGE_DRIVER)
    private readonly storageDriver?: IStorageDriver,
    @Optional()
    @Inject(STORAGE_NODE_REPOSITORY)
    private readonly storageNodeRepo?: IStorageNodeRepository,
    @Optional()
    @Inject(STORAGE_PORT)
    private readonly storagePort?: IStoragePort,
    @Optional()
    @Inject(PdfThumbnailService)
    private readonly pdfThumbnailService?: PdfThumbnailService,
  ) {}

  async getThumbnail(
    userId: string,
    attachmentId: string,
    fileId?: string | null,
  ): Promise<{ buffer: Buffer; mimeType: string }> {
    let blobId: string | null = null;
    let storageNode: Awaited<ReturnType<IStorageNodeRepository['findById']>> =
      null;

    if (fileId && this.storageNodeRepo) {
      try {
        storageNode = await this.storageNodeRepo.findById(fileId);
        if (storageNode?.blobId) {
          blobId = storageNode.blobId;
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.debug(
          `Could not resolve storage node for attachment ${attachmentId}: ${message}`,
        );
      }
    }

    if (blobId && this.storageDriver) {
      const thumbKey = `thumbnails/${blobId}.webp`;
      try {
        const exists = await this.storageDriver.exists(thumbKey);
        if (exists) {
          const { stream } = await this.storageDriver.getStream(thumbKey);
          const chunks: Buffer[] = [];
          for await (const chunk of stream) {
            chunks.push(
              Buffer.isBuffer(chunk)
                ? chunk
                : Buffer.from(chunk as Uint8Array | string),
            );
          }
          return {
            buffer: Buffer.concat(chunks),
            mimeType: 'image/webp',
          };
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.debug(
          `Failed reading existing thumbnail from storage driver: ${message}`,
        );
      }
    }

    let pdfBuffer: Buffer | null = null;
    if (fileId && this.storagePort?.readOwnedFile) {
      try {
        const fileRecord = await this.storagePort.readOwnedFile({
          fileId,
          userId,
        });
        if (fileRecord?.buffer) {
          pdfBuffer = fileRecord.buffer;
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.debug(
          `Failed to read owned file for thumbnail: ${message}`,
        );
      }
    }

    if (!pdfBuffer) {
      throw new NotFoundException(
        `No PDF binary available for attachment ${attachmentId}`,
      );
    }

    if (!this.pdfThumbnailService) {
      throw new NotFoundException('Thumbnail generator service is unavailable');
    }

    const thumbBuffer =
      await this.pdfThumbnailService.generateThumbnail(pdfBuffer);
    if (!thumbBuffer) {
      throw new NotFoundException(
        `Failed to generate thumbnail for attachment ${attachmentId}`,
      );
    }

    if (blobId && this.storageDriver) {
      const thumbKey = `thumbnails/${blobId}.webp`;
      try {
        await this.storageDriver.put(thumbKey, thumbBuffer, {
          mimeType: 'image/webp',
          size: thumbBuffer.length,
        });
        if (storageNode && this.storageNodeRepo) {
          const currentMeta = storageNode.metadata || {};
          storageNode.updateMetadata?.({
            ...currentMeta,
            thumbnail: `/api/v1/storage/files/r2/${encodeURIComponent(thumbKey)}`,
          });
          await this.storageNodeRepo.update(storageNode);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Could not persist generated thumbnail to driver: ${message}`,
        );
      }
    }

    return {
      buffer: thumbBuffer,
      mimeType: 'image/webp',
    };
  }
}
