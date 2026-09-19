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
} from './storage-queue.types';
import {
  STORAGE_DRIVER,
  STORAGE_NODE_REPOSITORY,
  STORAGE_BLOB_REPOSITORY,
} from '../../storage.tokens';
import { IStorageDriver } from '../../domain/ports/storage-driver.port';
import { IStorageNodeRepository } from '../../domain/ports/storage-node.repository.port';
import { IStorageBlobRepository } from '../../domain/ports/storage-blob.repository.port';
import { TrashRetentionJob } from '../jobs/trash-retention.cron';
import { MultipartCleanupJob } from '../jobs/multipart-cleanup.cron';
import { OrphanBlobJob } from '../jobs/orphan-blob.cron';
import { PdfThumbnailService } from '../services/pdf-thumbnail.service';

@Processor(STORAGE_PROCESSING_QUEUE, { concurrency: 3 })
export class StorageQueueConsumer
  extends WorkerHost
  implements OnApplicationBootstrap
{
  private readonly logger = new Logger(StorageQueueConsumer.name);

  constructor(
    @Inject(STORAGE_DRIVER) private readonly driver: IStorageDriver,
    @Inject(STORAGE_NODE_REPOSITORY)
    private readonly nodeRepo: IStorageNodeRepository,
    @Inject(STORAGE_BLOB_REPOSITORY)
    private readonly blobRepo: IStorageBlobRepository,
    @Optional() private readonly trashRetentionJob?: TrashRetentionJob,
    @Optional() private readonly multipartCleanupJob?: MultipartCleanupJob,
    @Optional() private readonly orphanBlobJob?: OrphanBlobJob,
    @Optional() private readonly pdfThumbnailService?: PdfThumbnailService,
  ) {
    super();
  }

  onApplicationBootstrap() {
    try {
      this.worker?.on('error', (err) => {
        this.logger.warn(`Storage Worker connection notice: ${err.message}`);
      });
    } catch {
      // ignore
    }
  }

  async process(job: Job<any>): Promise<any> {
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
        return this.orphanBlobJob?.processTombstonedBlobs();
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
      this.logger.log(
        `Completed processing job [${job.id}] for file ${data.fileId}`,
      );
    } catch (err: any) {
      this.logger.error(
        `Failed processing storage job [${job.id}] for ${data.fileId}: ${err?.message}`,
        err?.stack,
      );
      throw err; // Re-throw to trigger BullMQ retry backoff
    }
  }

  private async processImage(
    data: StorageProcessingJobData,
    node: any,
  ): Promise<void> {
    const { stream } = await this.driver.getStream(data.s3Key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const buffer = Buffer.concat(chunks);

    const image = sharp(buffer);
    const metadata = await image.metadata();

    const thumbBuffer = await sharp(buffer)
      .resize(250, 250, { fit: 'cover', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();

    const thumbKey = `thumbnails/${data.blobId}.webp`;
    await this.driver.put(thumbKey, thumbBuffer, {
      mimeType: 'image/webp',
      size: thumbBuffer.length,
    });

    const currentMeta = node.metadata || {};
    node.updateMetadata({
      ...currentMeta,
      thumbnail: `/api/files/r2/${encodeURIComponent(thumbKey)}`,
      dimensions: {
        width: metadata.width,
        height: metadata.height,
        format: metadata.format,
      },
    });
  }

  private async processPdf(
    data: StorageProcessingJobData,
    node: any,
  ): Promise<void> {
    const { stream } = await this.driver.getStream(data.s3Key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const buffer = Buffer.concat(chunks);

    try {
      const pdfDoc = await PDFDocument.load(buffer, { ignoreEncryption: true });
      const pageCount = pdfDoc.getPageCount();

      const currentMeta = node.metadata || {};
      let thumbnailPath: string | null = currentMeta.thumbnail || null;

      // In-process WebP thumbnail generation for page 1
      if (this.pdfThumbnailService && data.blobId) {
        try {
          const thumbBuffer =
            await this.pdfThumbnailService.generateThumbnail(buffer);
          if (thumbBuffer) {
            const thumbKey = `thumbnails/${data.blobId}.webp`;
            await this.driver.put(thumbKey, thumbBuffer, {
              mimeType: 'image/webp',
              size: thumbBuffer.length,
            });
            thumbnailPath = `/api/files/r2/${encodeURIComponent(thumbKey)}`;
            this.logger.log(
              `Generated and stored WebP thumbnail for PDF ${data.fileId}`,
            );
          }
        } catch (err: any) {
          this.logger.warn(
            `Could not generate thumbnail for PDF ${data.fileId}: ${err?.message}`,
          );
        }
      }

      node.updateMetadata({
        ...currentMeta,
        pageCount,
        ...(thumbnailPath ? { thumbnail: thumbnailPath } : {}),
      });
    } catch (err: any) {
      this.logger.warn(
        `Could not extract page count for PDF ${data.fileId}: ${err?.message}`,
      );
    }
  }

  private async processDataset(
    data: StorageProcessingJobData,
    node: any,
  ): Promise<void> {
    const { stream } = await this.driver.getStream(data.s3Key);
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
