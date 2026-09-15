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
    let deletedCount = 0;

    for (const blob of deadBlobs) {
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

    if (deletedCount > 0) {
      this.logger.log(
        `OrphanBlobJob reclaimed ${deletedCount} unused physical blobs from S3 storage`,
      );
    }
    return deletedCount;
  }
}
