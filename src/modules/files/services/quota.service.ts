import { Injectable, Inject, BadRequestException } from '@nestjs/common';
import {
  DEFAULT_STORAGE_QUOTA_BYTES,
  STORAGE_QUOTA_REPOSITORY,
} from '../files.constant';
import { StorageQuota } from '../domain/quota.domain';
import { IQuotaRepository } from '../repositories/quota.repository';

@Injectable()
export class QuotaService {
  constructor(
    @Inject(STORAGE_QUOTA_REPOSITORY)
    private readonly quotaRepo: IQuotaRepository,
  ) {}

  async getQuota(
    userId?: string | null,
    projectId?: string | null,
  ): Promise<StorageQuota | null> {
    return this.quotaRepo.findByScope(userId, projectId);
  }

  async assertAvailable(
    userId: string,
    projectId: string | null | undefined,
    requiredBytes: bigint,
  ): Promise<void> {
    const quota = await this.quotaRepo.findByScope(userId, projectId ?? null);
    const maxBytes = quota ? quota.maxBytes : DEFAULT_STORAGE_QUOTA_BYTES;
    const usedBytes = quota ? quota.usedBytes : 0n;
    if (usedBytes + requiredBytes > maxBytes) {
      throw new BadRequestException('Storage quota exceeded');
    }
  }

  async reserve(
    userId: string | null | undefined,
    projectId: string | null | undefined,
    bytes: bigint,
  ): Promise<bigint> {
    return this.quotaRepo.incrementUsage(userId, projectId ?? null, bytes);
  }

  async release(
    userId: string | null | undefined,
    projectId: string | null | undefined,
    bytes: bigint,
  ): Promise<bigint> {
    return this.quotaRepo.decrementUsage(userId, projectId ?? null, bytes);
  }
}
