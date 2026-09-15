import { Injectable, Logger, Inject } from '@nestjs/common';
import {
  STORAGE_DRIVER,
  UPLOAD_SESSION_REPOSITORY,
} from '../../storage.tokens';
import { IStorageDriver } from '../../domain/ports/storage-driver.port';
import { IUploadSessionRepository } from '../../domain/ports/upload-session.repository.port';

@Injectable()
export class MultipartCleanupJob {
  private readonly logger = new Logger(MultipartCleanupJob.name);

  constructor(
    @Inject(STORAGE_DRIVER) private readonly driver: IStorageDriver,
    @Inject(UPLOAD_SESSION_REPOSITORY)
    private readonly sessionRepo: IUploadSessionRepository,
  ) {}

  async processExpiredSessions(): Promise<number> {
    const now = new Date();
    const expired = await this.sessionRepo.findExpiredSessions(now, 100);
    let abortedCount = 0;

    for (const session of expired) {
      try {
        await this.driver.abortMultipartUpload(
          session.s3Key,
          session.s3UploadId,
        );
        session.markAborted();
        await this.sessionRepo.update(session);
        abortedCount++;
      } catch (err: any) {
        this.logger.warn(
          `Failed to abort expired multipart session ${session.id}: ${err.message}`,
        );
      }
    }

    if (abortedCount > 0) {
      this.logger.log(
        `MultipartCleanupJob aborted ${abortedCount} abandoned multipart upload sessions`,
      );
    }
    return abortedCount;
  }
}
