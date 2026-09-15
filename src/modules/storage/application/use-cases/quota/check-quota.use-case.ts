import { Injectable, Inject } from '@nestjs/common';
import { STORAGE_QUOTA_REPOSITORY } from '../../../storage.tokens';
import { IStorageQuotaRepository } from '../../../domain/ports/storage-quota.repository.port';

@Injectable()
export class CheckQuotaUseCase {
  constructor(
    @Inject(STORAGE_QUOTA_REPOSITORY)
    private readonly quotaRepo: IStorageQuotaRepository,
  ) {}

  async execute(userId?: string | null, projectId?: string | null) {
    const quota = await this.quotaRepo.findByScope(userId, projectId);
    const DEFAULT_LIMIT = 5n * 1024n * 1024n * 1024n; // 5 GB
    const usedBytes = quota ? quota.usedBytes : 0n;
    const maxBytes = quota ? quota.maxBytes : DEFAULT_LIMIT;

    return {
      usedBytes: Number(usedBytes),
      maxBytes: Number(maxBytes),
      percentage: Number((usedBytes * 10000n) / maxBytes) / 100,
    };
  }
}
