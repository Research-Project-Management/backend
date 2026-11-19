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

  async getQuota(spaceId?: string | null): Promise<StorageQuota | null> {
    if (!spaceId) {
      return null;
    }
    return this.quotaRepo.findBySpaceId(spaceId);
  }

  async assertAvailable(
    spaceId: string | null | undefined,
    requiredBytes: bigint,
  ): Promise<void> {
    const quota = spaceId ? await this.quotaRepo.findBySpaceId(spaceId) : null;
    const maxBytes = quota ? quota.maxBytes : DEFAULT_STORAGE_QUOTA_BYTES;
    const usedBytes = quota ? quota.usedBytes : 0n;
    if (usedBytes + requiredBytes > maxBytes) {
      throw new BadRequestException('Storage quota exceeded');
    }
  }

  async reserve(
    spaceId: string | null | undefined,
    bytes: bigint,
  ): Promise<bigint> {
    if (!spaceId) {
      return 0n;
    }
    return this.quotaRepo.incrementUsage(spaceId, bytes);
  }

  async release(
    spaceId: string | null | undefined,
    bytes: bigint,
  ): Promise<bigint> {
    if (!spaceId) {
      return 0n;
    }
    return this.quotaRepo.decrementUsage(spaceId, bytes);
  }
}
