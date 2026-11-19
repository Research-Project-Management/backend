import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Job } from 'bullmq';
import {
  FILES_JOB_CLEANUP_EXPIRED_SESSIONS,
  FILES_JOB_RECLAIM_ORPHAN_BLOBS,
  FILES_MAINTENANCE_QUEUE,
} from '../files.constant';
import { BlobService } from '../services/blob.service';
import { PresignService } from '../services/presign.service';

/**
 * Dedicated BullMQ consumer for physical storage maintenance in FilesModule:
 * aborts expired multipart upload sessions and reclaims tombstoned orphan blobs.
 */
@Processor(FILES_MAINTENANCE_QUEUE, { concurrency: 1 })
export class FilesMaintenanceProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  private readonly logger = new Logger(FilesMaintenanceProcessor.name);

  constructor(
    private readonly blobService: BlobService,
    private readonly presignService: PresignService,
  ) {
    super();
  }

  onApplicationBootstrap(): void {
    try {
      this.worker?.on('error', (err) => {
        this.logger.warn(
          `Files maintenance worker connection notice: ${err.message}`,
        );
      });
    } catch (err: unknown) {
      this.logger.debug(
        `Files maintenance worker listener initialization skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async process(job: Job<unknown>): Promise<number | null> {
    switch (job.name) {
      case FILES_JOB_CLEANUP_EXPIRED_SESSIONS: {
        this.logger.log(
          `Running FilesModule maintenance: Cleanup expired multipart sessions [${job.id}]`,
        );
        return this.presignService.cleanupExpiredSessions(100);
      }
      case FILES_JOB_RECLAIM_ORPHAN_BLOBS: {
        this.logger.log(
          `Running FilesModule maintenance: Reclaim orphan CAS blobs [${job.id}]`,
        );
        return this.blobService.reclaimOrphanBlobs(100);
      }
      default: {
        this.logger.warn(
          `Received unknown FilesModule maintenance job "${job.name}" [${job.id}]`,
        );
        return null;
      }
    }
  }
}
