import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUES } from '@/core';
import { FILE_JOBS, MAX_CONCURRENT_THUMBNAIL_RENDERS } from '../files.constant';
import { ThumbnailService } from '../services/thumbnail.service';
import { RequestThumbnailInput } from '../types/files.type';

/**
 * Dedicated BullMQ consumer offloading CPU/RAM-heavy PDF and image
 * derivative generation away from HTTP request handlers.
 */
@Processor(QUEUES.FILE_MEDIA, { concurrency: MAX_CONCURRENT_THUMBNAIL_RENDERS })
export class MediaProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  private readonly logger = new Logger(MediaProcessor.name);

  constructor(private readonly thumbnailService: ThumbnailService) {
    super();
  }

  onApplicationBootstrap(): void {
    try {
      this.worker?.on('error', (err) => {
        this.logger.warn(
          `Files media worker connection notice: ${err.message}`,
        );
      });
    } catch (err: unknown) {
      this.logger.debug(
        `Files media worker listener initialization skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async process(job: Job<RequestThumbnailInput>): Promise<boolean> {
    if (job.name !== FILE_JOBS.THUMBNAIL) {
      this.logger.warn(
        `Received unknown FilesModule media job "${job.name}" [${job.id}]`,
      );
      return false;
    }

    return this.thumbnailService.generateAndCacheDerivative(job.data);
  }
}
