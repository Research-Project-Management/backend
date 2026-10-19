import { Processor, WorkerHost } from '@nestjs/bullmq';
import {
  Logger,
  Inject,
  Optional,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { Job } from 'bullmq';
import sharp from 'sharp';
import { createInterface } from 'readline';
import { PDFDocument } from 'pdf-lib';
import {
  STORAGE_PROCESSING_QUEUE,
  STORAGE_JOB_PROCESS_FILE,
  STORAGE_JOB_MAINTENANCE_TRASH,
  STORAGE_JOB_MAINTENANCE_MULTIPART,
  STORAGE_JOB_MAINTENANCE_ORPHAN,
  StorageProcessingJobData,
} from '../types';
import { STORAGE_NODE_REPOSITORY } from '@/modules/storage/storage.tokens';
import { IStorageNodeRepository, StorageNode } from '@/modules/storage/drive';
import {
  BlobService,
  StorageRedisCacheService,
  streamToBuffer,
} from '@/modules/storage/core';
import { TrashRetentionJob, MultipartCleanupJob } from './lifecycle.service';
import { PdfThumbnailService } from '../services/pdf-thumbnail.service';

@Processor(STORAGE_PROCESSING_QUEUE, { concurrency: 3 })
export class StorageQueueConsumer
  extends WorkerHost
  implements OnApplicationBootstrap
{
  private readonly logger = new Logger(StorageQueueConsumer.name);

  constructor(
    private readonly blobService: BlobService,
    @Inject(STORAGE_NODE_REPOSITORY)
    private readonly nodeRepo: IStorageNodeRepository,
    @Optional()
    private readonly trashRetentionJob?: TrashRetentionJob,
    @Optional()
    private readonly multipartCleanupJob?: MultipartCleanupJob,
    @Optional()
    private readonly pdfThumbnailService?: PdfThumbnailService,
    @Optional()
    private readonly cacheService?: StorageRedisCacheService,
  ) {
    super();
  }

  onApplicationBootstrap() {
    try {
      this.worker?.on('error', (err) => {
        this.logger.warn(`Storage Worker connection notice: ${err.message}`);
      });
    } catch (err: unknown) {
      this.logger.debug(
        `Storage worker listener initialization skipped: ${(err as Error)?.message}`,
      );
    }
  }

  async process(job: Job<unknown>): Promise<unknown> {
    switch (job.name) {
      case STORAGE_JOB_MAINTENANCE_TRASH: {
        this.logger.log(
          `Starting scheduled maintenance: Trash Retention [${job.id}]`,
        );
        return this.trashRetentionJob?.processExpiredTrash();
      }
      case STORAGE_JOB_MAINTENANCE_MULTIPART: {
        this.logger.log(
          `Starting scheduled maintenance: Multipart Cleanup [${job.id}]`,
        );
        return this.multipartCleanupJob?.processExpiredSessions();
      }
      case STORAGE_JOB_MAINTENANCE_ORPHAN: {
        this.logger.log(
          `Starting scheduled maintenance: Orphan Blob GC [${job.id}]`,
        );
        return this.blobService.reclaimOrphanBlobs(100);
      }
      case STORAGE_JOB_PROCESS_FILE:
      default: {
        return this.processFile(job as Job<StorageProcessingJobData>);
      }
    }
  }

  private async processFile(job: Job<StorageProcessingJobData>): Promise<void> {
    const data = job.data;
    this.logger.log(
      `Processing storage job [${job.id}] for file: ${data.filename} (${data.mimeType})`,
    );

    const node = await this.nodeRepo.findById(data.fileId);
    if (!node || node.isTrashed()) {
      this.logger.warn(
        `Storage node ${data.fileId} not found or trashed. Skipping.`,
      );
      return;
    }

    try {
      if (
        data.mimeType.startsWith('image/') &&
        data.mimeType !== 'image/svg+xml'
      ) {
        await this.processImage(data, node);
      } else if (data.mimeType === 'application/pdf') {
        await this.processPdf(data, node);
      } else if (
        data.mimeType === 'text/csv' ||
        data.mimeType === 'text/tab-separated-values' ||
        /\.(csv|tsv)$/i.test(data.filename)
      ) {
        await this.processDataset(data, node);
      }

      await this.nodeRepo.update(node);
      await this.cacheService?.invalidateFolder(
        node.projectId ?? node.authorId,
        node.parentId,
      );
      this.logger.log(
        `Completed processing job [${job.id}] for file ${data.fileId}`,
      );
    } catch (err: unknown) {
      const errorObj = err as {
        name?: string;
        Code?: string;
        message?: string;
        stack?: string;
      };
      if (
        errorObj?.name === 'NoSuchKey' ||
        errorObj?.Code === 'NoSuchKey' ||
        errorObj?.message?.includes('NoSuchKey') ||
        errorObj?.message?.includes('The specified key does not exist')
      ) {
        this.logger.warn(
          `Storage job [${job.id}] skipped for ${data.fileId}: S3 key "${data.s3Key}" not found. File may have been removed or incomplete upload.`,
        );
        return;
      }
      this.logger.error(
        `Failed processing storage job [${job.id}] for ${data.fileId}: ${errorObj?.message}`,
        errorObj?.stack,
      );
      throw err; // Re-throw to trigger BullMQ retry backoff
    }
  }

  private async processImage(
    data: StorageProcessingJobData,
    node: StorageNode,
  ): Promise<void> {
    const { stream } = await this.blobService.getStream(data.s3Key);
    const buffer = await streamToBuffer(stream);

    const image = sharp(buffer);
    const metadata = await image.metadata();

    const thumbBuffer = await sharp(buffer)
      .resize(250, 250, { fit: 'cover', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();

    const thumbKey = `thumbnails/${data.blobId}.webp`;
    await this.blobService.put(thumbKey, thumbBuffer, {
      mimeType: 'image/webp',
      size: thumbBuffer.length,
    });

    const currentMeta = node.metadata || {};
    node.updateMetadata({
      ...currentMeta,
      thumbnail: `/api/v1/storage/files/r2/${encodeURIComponent(thumbKey)}`,
      dimensions: {
        width: metadata.width,
        height: metadata.height,
        format: metadata.format,
      },
    });
  }

  private async processPdf(
    data: StorageProcessingJobData,
    node: StorageNode,
  ): Promise<void> {
    const { stream } = await this.blobService.getStream(data.s3Key);
    const buffer = await streamToBuffer(stream);

    try {
      const pdfDoc = await PDFDocument.load(buffer, { ignoreEncryption: true });
      const pageCount = pdfDoc.getPageCount();

      const currentMeta = node.metadata || {};
      let thumbnailPath: string | null =
        (currentMeta.thumbnail as string) || null;

      // In-process WebP thumbnail generation for page 1
      if (this.pdfThumbnailService && data.blobId) {
        try {
          const thumbBuffer =
            await this.pdfThumbnailService.generateThumbnail(buffer);
          if (thumbBuffer) {
            const thumbKey = `thumbnails/${data.blobId}.webp`;
            await this.blobService.put(thumbKey, thumbBuffer, {
              mimeType: 'image/webp',
              size: thumbBuffer.length,
            });
            thumbnailPath = `/api/v1/storage/files/r2/${encodeURIComponent(thumbKey)}`;
            this.logger.log(
              `Generated and stored WebP thumbnail for PDF ${data.fileId}`,
            );
          }
        } catch (err: unknown) {
          this.logger.warn(
            `Could not generate thumbnail for PDF ${data.fileId}: ${(err as Error)?.message}`,
          );
        }
      }

      node.updateMetadata({
        ...currentMeta,
        pageCount,
        ...(thumbnailPath ? { thumbnail: thumbnailPath } : {}),
      });
    } catch (err: unknown) {
      this.logger.warn(
        `Could not extract page count for PDF ${data.fileId}: ${(err as Error)?.message}`,
      );
    }
  }

  private async processDataset(
    data: StorageProcessingJobData,
    node: StorageNode,
  ): Promise<void> {
    const { stream } = await this.blobService.getStream(data.s3Key);
    const rl = createInterface({
      input: stream,
      crlfDelay: Infinity,
    });

    const lines: string[] = [];
    let header: string[] = [];
    let lineCount = 0;

    for await (const line of rl) {
      if (lineCount === 0) {
        header = line
          .split(/[,\t]/)
          .map((col) => col.trim().replace(/^"|"$/g, ''));
      } else if (lineCount <= 100) {
        lines.push(line);
      }
      lineCount++;
      if (lineCount >= 1000) {
        break; // Stop streaming sample
      }
    }

    const currentMeta = node.metadata || {};
    node.updateMetadata({
      ...currentMeta,
      datasetPreview: {
        columns: header,
        totalSampledRows: lineCount,
        sampleRows: lines.slice(0, 50).map((l) => l.split(/[,\t]/)),
      },
    });
  }
}
