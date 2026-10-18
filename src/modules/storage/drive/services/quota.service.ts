import { Injectable, Inject } from '@nestjs/common';
import { STORAGE_QUOTA_REPOSITORY } from '@/modules/storage/storage.tokens';
import { IStorageQuotaRepository } from '../repositories/prisma-quota.repository';
import { DEFAULT_STORAGE_QUOTA_BYTES } from '../types';

export interface QuotaCheckResult {
  usedBytes: number;
  maxBytes: number;
  percentage: number;
}

@Injectable()
export class QuotaService {
  constructor(
    @Inject(STORAGE_QUOTA_REPOSITORY)
    private readonly quotaRepo: IStorageQuotaRepository,
  ) {}

  async check(
    userId?: string | null,
    projectId?: string | null,
  ): Promise<QuotaCheckResult> {
    const quota = await this.quotaRepo.findByScope(userId, projectId);
    const usedBytes = quota ? quota.usedBytes : 0n;
    const maxBytes = quota ? quota.maxBytes : DEFAULT_STORAGE_QUOTA_BYTES;

    return {
      usedBytes: Number(usedBytes),
      maxBytes: Number(maxBytes),
      percentage: Number((usedBytes * 10000n) / maxBytes) / 100,
    };
  }
}
