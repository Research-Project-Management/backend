import { Injectable, Logger } from '@nestjs/common';
import { RedisCacheService } from '@/core/cache/redis.service';

@Injectable()
export class StorageRedisCacheService {
  private readonly logger = new Logger(StorageRedisCacheService.name);

  constructor(private readonly redis: RedisCacheService) {}

  private getTreeKey(scopeKey: string, parentId?: string | null): string {
    return `flux:storage:tree:${scopeKey}:${parentId ?? 'root'}`;
  }

  async getFolderListing<T>(
    scopeKey: string,
    parentId?: string | null,
  ): Promise<T | null> {
    const key = this.getTreeKey(scopeKey, parentId);
    return this.redis.get<T>(key);
  }

  async setFolderListing(
    scopeKey: string,
    parentId: string | null | undefined,
    data: any,
    ttlSeconds = 1800,
  ): Promise<void> {
    const key = this.getTreeKey(scopeKey, parentId);
    await this.redis.set(key, data, ttlSeconds);
  }

  async invalidateFolder(
    scopeKey: string,
    parentId?: string | null,
  ): Promise<void> {
    const key = this.getTreeKey(scopeKey, parentId);
    await this.redis.del(key);
  }

  async invalidateScopeTree(scopeKey: string): Promise<void> {
    await this.redis.delPattern(`flux:storage:tree:${scopeKey}:*`);
  }

  async getPresignedUrl(blobId: string): Promise<string | null> {
    return this.redis.get<string>(`flux:storage:url:${blobId}`);
  }

  async setPresignedUrl(
    blobId: string,
    url: string,
    ttlSeconds = 3300,
  ): Promise<void> {
    await this.redis.set(`flux:storage:url:${blobId}`, url, ttlSeconds);
  }

  async invalidatePresignedUrl(blobId: string): Promise<void> {
    await this.redis.del(`flux:storage:url:${blobId}`);
  }

  private getQuotaKey(
    userId?: string | null,
    projectId?: string | null,
  ): string {
    return `flux:quota:${userId ?? 'global'}:${projectId ?? 'personal'}`;
  }

  async getCachedQuota(
    userId?: string | null,
    projectId?: string | null,
  ): Promise<{ usedBytes: string; maxBytes: string } | null> {
    const key = this.getQuotaKey(userId, projectId);
    return this.redis.get<{ usedBytes: string; maxBytes: string }>(key);
  }

  async setCachedQuota(
    userId: string | null | undefined,
    projectId: string | null | undefined,
    usedBytes: bigint,
    maxBytes: bigint,
    ttlSeconds = 3600,
  ): Promise<void> {
    const key = this.getQuotaKey(userId, projectId);
    await this.redis.set(
      key,
      { usedBytes: usedBytes.toString(), maxBytes: maxBytes.toString() },
      ttlSeconds,
    );
  }

  async invalidateQuota(
    userId?: string | null,
    projectId?: string | null,
  ): Promise<void> {
    const key = this.getQuotaKey(userId, projectId);
    await this.redis.del(key);
  }
}
