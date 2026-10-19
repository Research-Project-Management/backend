import { Injectable, Logger } from '@nestjs/common';
import { RedisCacheService } from '@/core';

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
    data: unknown,
    ttlSeconds = 1800,
  ): Promise<void> {
    const key = this.getTreeKey(scopeKey, parentId);
    await this.redis.set(key, data, ttlSeconds);
  }

  private readonly inFlight = new Map<string, Promise<unknown>>();

  async wrapFolderListing<T>(
    scopeKey: string,
    parentId: string | null | undefined,
    factory: () => Promise<T>,
    ttlSeconds = 120,
  ): Promise<T> {
    const cached = await this.getFolderListing<T>(scopeKey, parentId);
    if (cached !== null && cached !== undefined) return cached;

    const key = this.getTreeKey(scopeKey, parentId);
    const existing = this.inFlight.get(key);
    if (existing) {
      return existing as Promise<T>;
    }

    const promise = (async () => {
      try {
        const fresh = await factory();
        await this.setFolderListing(scopeKey, parentId, fresh, ttlSeconds);
        return fresh;
      } finally {
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, promise);
    return promise;
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
}
