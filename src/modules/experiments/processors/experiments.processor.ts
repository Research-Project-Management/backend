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
  BlobService,
  streamToBuffer,
  ThumbnailService,
} from '@/modules/files';
import {
  EXPERIMENT_NODE_REPOSITORY,
  EXPERIMENTS_PROCESSING_QUEUE,
  EXPERIMENTS_JOB_MAINTENANCE_MULTIPART,
  EXPERIMENTS_JOB_MAINTENANCE_ORPHAN,
  EXPERIMENTS_JOB_MAINTENANCE_TRASH,
  EXPERIMENTS_JOB_PROCESS_FILE,
} from '../experiments.constant';
import { ExperimentsProcessingJobData } from '../experiments.type';
import { INodeRepository } from '../repositories/node.repository';
import { ExperimentNode } from '../domain/node.domain';
import { ExperimentsCacheService } from '../services/cache.service';
import {
  MultipartCleanupJob,
  TrashRetentionJob,
} from '../services/lifecycle.service';

@Processor(EXPERIMENTS_PROCESSING_QUEUE, { concurrency: 3 })
export class ExperimentsQueueConsumer
  extends WorkerHost
  implements OnApplicationBootstrap
{
  private readonly logger = new Logger(ExperimentsQueueConsumer.name);

  constructor(
    private readonly blobService: BlobService,
    @Inject(EXPERIMENT_NODE_REPOSITORY)
    private readonly nodeRepo: INodeRepository,
    @Optional()
    private readonly trashRetentionJob?: TrashRetentionJob,
    @Optional()
    private readonly multipartCleanupJob?: MultipartCleanupJob,
    @Optional()
    private readonly pdfThumbnailService?: ThumbnailService,
    @Optional()
    private readonly cacheService?: ExperimentsCacheService,
  ) {
    super();
  }

  onApplicationBootstrap() {
    try {
      this.worker?.on('error', (err) => {
        this.logger.warn(`Experiments Worker connection notice: ${err.message}`);
      });
    } catch (err: unknown) {
      this.logger.debug(
        `Experiments worker listener initialization skipped: ${(err as Error)?.message}`,
      );
    }
  }

  async process(job: Job<unknown>): Promise<unknown> {
    switch (job.name) {
      case EXPERIMENTS_JOB_MAINTENANCE_TRASH: {
        this.logger.log(
          `Starting scheduled maintenance: Trash Retention [${job.id}]`,
        );
        return this.trashRetentionJob?.processExpiredTrash();
      }
      case EXPERIMENTS_JOB_MAINTENANCE_MULTIPART: {
        this.logger.log(
          `Starting scheduled maintenance: Multipart Cleanup [${job.id}]`,
        );
        return this.multipartCleanupJob?.processExpiredSessions();
      }
      case EXPERIMENTS_JOB_MAINTENANCE_ORPHAN: {
        this.logger.log(
          `Starting scheduled maintenance: Orphan Blob GC [${job.id}]`,
        );
        return this.blobService.reclaimOrphanBlobs(100);
      }
      case EXPERIMENTS_JOB_PROCESS_FILE:
      default: {
        return this.processFile(job as Job<ExperimentsProcessingJobData>);
      }
    }
  }

  private async processFile(
    job: Job<ExperimentsProcessingJobData>,
  ): Promise<void> {
    const data = job.data;
    this.logger.log(
      `Processing file job [${job.id}] for file: ${data.filename} (${data.mimeType})`,
    );

    const node = await this.nodeRepo.findById(data.fileId);
    if (!node || node.isTrashed()) {
      this.logger.warn(
        `Experiment node ${data.fileId} not found or trashed. Skipping.`,
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
          `Processing job [${job.id}] skipped for ${data.fileId}: S3 key "${data.s3Key}" not found.`,
        );
        return;
      }
      this.logger.error(
        `Failed processing job [${job.id}] for ${data.fileId}: ${errorObj?.message}`,
        errorObj?.stack,
      );
      throw err;
    }
  }

  private async processImage(
    data: ExperimentsProcessingJobData,
    node: ExperimentNode,
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
      thumbnail: `/api/v1/experiments/files/r2/${encodeURIComponent(thumbKey)}`,
      dimensions: {
        width: metadata.width,
        height: metadata.height,
        format: metadata.format,
      },
    });
  }

  private async processPdf(
    data: ExperimentsProcessingJobData,
    node: ExperimentNode,
  ): Promise<void> {
    const stat =
      typeof this.blobService.stat === 'function'
        ? await Promise.resolve(this.blobService.stat(data.s3Key)).catch(
            () => null,
          )
        : null;
    if (stat && stat.size > 25 * 1024 * 1024) {
      this.logger.warn(
        `Skipping in-memory PDF parse for ${data.s3Key} (${stat.size} bytes > 25 MB limit)`,
      );
      node.updateMetadata({
        ...(node.metadata || {}),
        largePdfSkippedInMemoryParse: true,
      });
      return;
    }

    const { stream } = await this.blobService.getStream(data.s3Key);
    const buffer = await streamToBuffer(stream);

    try {
      const pdfDoc = await PDFDocument.load(buffer, { ignoreEncryption: true });
      const pageCount = pdfDoc.getPageCount();

      const currentMeta = node.metadata || {};
      let thumbnailPath: string | null =
        (currentMeta.thumbnail as string) || null;

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
            thumbnailPath = `/api/v1/experiments/files/r2/${encodeURIComponent(thumbKey)}`;
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
    data: ExperimentsProcessingJobData,
    node: ExperimentNode,
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
        break;
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

