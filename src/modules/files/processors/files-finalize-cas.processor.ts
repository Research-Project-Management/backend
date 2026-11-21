import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import {
  Inject,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import * as crypto from 'crypto';
import {
  FILES_FINALIZE_CAS_QUEUE,
  FILES_JOB_DELETE_STAGING_OBJECT,
  FILES_JOB_PROMOTE_CAS,
  MAX_CONCURRENT_CAS_PROMOTIONS,
  STAGING_DELETE_DELAY_MS,
  STORAGE_ADAPTER,
} from '../files.constant';
import { BlobRepository } from '../repositories/blob.repository';
import { BlobService } from '../services/blob.service';
import { IStorageAdapter } from '../types/adapter.type';
import {
  DeleteStagingObjectJobData,
  PromoteCasJobData,
} from '../types/files.type';

/**
 * Dedicated BullMQ consumer for async CAS promotion:
 * computes SHA-256 on staging objects, copies to canonical CAS (or isolated
 * unhashed prefix on post-facto collision), atomically updates DB storageKey,
 * and schedules delayed staging object cleanup after download URL TTL safety window.
 */
@Processor(FILES_FINALIZE_CAS_QUEUE, {
  concurrency: MAX_CONCURRENT_CAS_PROMOTIONS,
})
export class FilesFinalizeCasProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  private readonly logger = new Logger(FilesFinalizeCasProcessor.name);

  constructor(
    @Inject(STORAGE_ADAPTER) private readonly driver: IStorageAdapter,
    private readonly blobService: BlobService,
    private readonly blobRepo: BlobRepository,
    @Optional()
    @InjectQueue(FILES_FINALIZE_CAS_QUEUE)
    private readonly finalizeCasQueue?: Queue,
  ) {
    super();
  }

  onApplicationBootstrap(): void {
    try {
      this.worker?.on('error', (err) => {
        this.logger.warn(
          `Files CAS promotion worker connection notice: ${err.message}`,
        );
      });
    } catch (err: unknown) {
      this.logger.debug(
        `Files CAS promotion worker listener initialization skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async process(
    job: Job<PromoteCasJobData | DeleteStagingObjectJobData>,
  ): Promise<unknown> {
    switch (job.name) {
      case FILES_JOB_PROMOTE_CAS: {
        const data = job.data as PromoteCasJobData;
        const result = await this.blobService.promoteStagingBlobToCas(data);
        const lagMs =
          typeof job.timestamp === 'number' ? Date.now() - job.timestamp : null;
        this.logger.log(
          `metric=finalize_cas blobId=${data.blobId} promoted=${result.promoted} isolated=${result.isolated} lag_ms=${lagMs ?? 'n/a'} attempts=${job.attemptsMade ?? 0}`,
        );
        if (result.stagingKeyToDelete && this.finalizeCasQueue) {
          const keyDigest = crypto
            .createHash('sha256')
            .update(result.stagingKeyToDelete)
            .digest('hex')
            .slice(0, 24);
          try {
            await this.finalizeCasQueue.add(
              FILES_JOB_DELETE_STAGING_OBJECT,
              { storageKey: result.stagingKeyToDelete },
              {
                delay: STAGING_DELETE_DELAY_MS,
                jobId: `del-staging-${keyDigest}`,
                attempts: 3,
                backoff: { type: 'exponential', delay: 10_000 },
                removeOnComplete: 200,
                removeOnFail: 200,
              },
            );
          } catch (enqueueErr: unknown) {
            this.logger.warn(
              `Failed to enqueue delayed cleanup for staging key ${result.stagingKeyToDelete}: ${enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr)}`,
            );
          }
        }
        return result;
      }

      case FILES_JOB_DELETE_STAGING_OBJECT: {
        const data = job.data as DeleteStagingObjectJobData;
        const storageKey = data?.storageKey;
        if (!storageKey || !storageKey.startsWith('uploads/staging/')) {
          return false;
        }
        if (await this.blobRepo.existsByStorageKey(storageKey)) {
          return false;
        }
        try {
          await this.driver.delete(storageKey);
        } catch (err: unknown) {
          if (!(err instanceof NotFoundException)) {
            throw err;
          }
        }
        return true;
      }

      default: {
        this.logger.warn(
          `Received unknown FilesModule CAS job "${job.name}" [${job.id}]`,
        );
        return null;
      }
    }
  }
}
