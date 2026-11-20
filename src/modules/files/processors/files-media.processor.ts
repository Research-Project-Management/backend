import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Job } from 'bullmq';
import {
  FILES_JOB_GENERATE_THUMBNAIL,
  FILES_MEDIA_QUEUE,
  MAX_CONCURRENT_THUMBNAIL_RENDERS,
} from '../files.constant';
import { ThumbnailService } from '../services/thumbnail.service';
import { RequestThumbnailInput } from '../types/files.type';

/**
 * Dedicated BullMQ consumer offloading CPU/RAM-heavy PDF and image
 * derivative generation away from HTTP request handlers.
 */
@Processor(FILES_MEDIA_QUEUE, { concurrency: MAX_CONCURRENT_THUMBNAIL_RENDERS })
export class FilesMediaProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  private readonly logger = new Logger(FilesMediaProcessor.name);

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
    if (job.name !== FILES_JOB_GENERATE_THUMBNAIL) {
      this.logger.warn(
        `Received unknown FilesModule media job "${job.name}" [${job.id}]`,
      );
      return false;
    }

    return this.thumbnailService.generateAndCacheDerivative(job.data);
  }
}
