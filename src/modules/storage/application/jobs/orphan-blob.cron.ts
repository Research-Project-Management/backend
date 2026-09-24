import { Injectable, Logger, Inject } from '@nestjs/common';
import { STORAGE_DRIVER, STORAGE_BLOB_REPOSITORY } from '../../storage.tokens';
import { IStorageDriver } from '../../domain/ports/storage-driver.port';
import { IStorageBlobRepository } from '../../domain/ports/storage-blob.repository.port';

@Injectable()
export class OrphanBlobJob {
  private readonly logger = new Logger(OrphanBlobJob.name);

  constructor(
    @Inject(STORAGE_DRIVER) private readonly driver: IStorageDriver,
    @Inject(STORAGE_BLOB_REPOSITORY)
    private readonly blobRepo: IStorageBlobRepository,
  ) {}

  async processTombstonedBlobs(): Promise<number> {
    const now = new Date();
    const deadBlobs = await this.blobRepo.findTombstonedBlobs(now, 100);
    if (deadBlobs.length === 0) {
      return 0;
    }

    let deletedCount = 0;
    const BATCH_SIZE = 500;

    for (let i = 0; i < deadBlobs.length; i += BATCH_SIZE) {
      const batch = deadBlobs.slice(i, i + BATCH_SIZE);
      const keys = batch.map((b) => b.s3Key.value());

      // Use high-performance batch S3 deletion if driver supports it and more than 1 blob in batch
      if (typeof this.driver.deleteMany === 'function' && batch.length > 1) {
        try {
          await this.driver.deleteMany(keys);

          for (const blob of batch) {
            try {
              await this.blobRepo.delete(blob.id);
              deletedCount++;
            } catch (err: any) {
              this.logger.error(
                `Failed to delete tombstoned blob ${blob.id} from DB: ${err.message}`,
              );
            }
          }
          continue;
        } catch (batchErr: any) {
          this.logger.warn(
            `Batch deletion failed, falling back to sequential reclamation: ${batchErr.message}`,
          );
        }
      }

      // Sequential deletion for single items, fallback, or drivers without deleteMany
      for (const blob of batch) {
        try {
          await this.driver.delete(blob.s3Key.value());
          await this.blobRepo.delete(blob.id);
          deletedCount++;
        } catch (err: any) {
          this.logger.error(
            `Failed to sweep orphan blob ${blob.id} from S3: ${err.message}`,
          );
        }
      }
    }

    if (deletedCount > 0) {
      this.logger.log(
        `OrphanBlobJob reclaimed ${deletedCount} unused physical blobs from S3 storage (Batch mode)`,
      );
    }
    return deletedCount;
  }
}
