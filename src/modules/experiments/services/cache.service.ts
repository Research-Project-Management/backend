import { Injectable, Logger } from '@nestjs/common';
import { RedisCacheService } from '@/core';

export const EXPERIMENTS_CACHE_KEYS = {
  tree: (scopeKey: string, parentId?: string | null) =>
    `flux:experiments:tree:${scopeKey}:${parentId ?? 'root'}`,
  treePattern: (scopeKey: string) => `flux:experiments:tree:${scopeKey}:*`,
  presignedUrl: (blobId: string) => `flux:experiments:url:${blobId}`,
  nodeMeta: (nodeId: string) => `flux:experiments:node-meta:${nodeId}`,
} as const;

@Injectable()
export class ExperimentsCacheService {
  private readonly logger = new Logger(ExperimentsCacheService.name);

  constructor(private readonly redis: RedisCacheService) {}

  private getTreeKey(scopeKey: string, parentId?: string | null): string {
    return EXPERIMENTS_CACHE_KEYS.tree(scopeKey, parentId);
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

  async wrapFolderListing<T>(
    scopeKey: string,
    parentId: string | null | undefined,
    factory: () => Promise<T>,
    ttlSeconds = 120,
  ): Promise<T> {
    const key = this.getTreeKey(scopeKey, parentId);
    return this.redis.wrap(key, factory, ttlSeconds);
  }

  async invalidateFolder(
    scopeKey: string,
    parentId?: string | null,
  ): Promise<void> {
    const key = this.getTreeKey(scopeKey, parentId);
    await this.redis.del(key);
  }

  async invalidateScopeTree(scopeKey: string): Promise<void> {
    await this.redis.delPattern(EXPERIMENTS_CACHE_KEYS.treePattern(scopeKey));
  }

  async getPresignedUrl(blobId: string): Promise<string | null> {
    return this.redis.get<string>(EXPERIMENTS_CACHE_KEYS.presignedUrl(blobId));
  }

  async setPresignedUrl(
    blobId: string,
    url: string,
    ttlSeconds = 3300,
  ): Promise<void> {
    await this.redis.set(
      EXPERIMENTS_CACHE_KEYS.presignedUrl(blobId),
      url,
      ttlSeconds,
    );
  }

  async getStreamNodeMeta<T>(nodeId: string): Promise<T | null> {
    return this.redis.get<T>(EXPERIMENTS_CACHE_KEYS.nodeMeta(nodeId));
  }

  async setStreamNodeMeta(
    nodeId: string,
    meta: unknown,
    ttlSeconds = 60,
  ): Promise<void> {
    await this.redis.set(
      EXPERIMENTS_CACHE_KEYS.nodeMeta(nodeId),
      meta,
      ttlSeconds,
    );
  }

  async invalidateStreamNodeMeta(nodeId: string): Promise<void> {
    await this.redis.del(`flux:experiments:node-meta:${nodeId}`);
  }
}
