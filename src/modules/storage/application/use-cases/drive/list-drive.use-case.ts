import { Injectable, Inject } from '@nestjs/common';
import { STORAGE_NODE_REPOSITORY } from '../../../storage.tokens';
import {
  IStorageNodeRepository,
  ListDriveFilter,
} from '../../../domain/ports/storage-node.repository.port';
import { StorageRedisCacheService } from '../../../infrastructure/cache/storage-redis-cache.service';
import { StorageNode } from '../../../domain/entities/storage-node.entity';

@Injectable()
export class ListDriveUseCase {
  constructor(
    @Inject(STORAGE_NODE_REPOSITORY)
    private readonly nodeRepo: IStorageNodeRepository,
    private readonly cache: StorageRedisCacheService,
  ) {}

  async execute(
    filter: ListDriveFilter,
  ): Promise<{ nodes: StorageNode[]; total: number }> {
    const scopeKey =
      filter.projectId ?? filter.userId ?? filter.authorId ?? 'default';

    // Only cache top-level / active root folder queries without search/filter
    const isFilterActive =
      filter.trashedOnly ||
      filter.starredOnly ||
      Boolean(filter.offset) ||
      Boolean(filter.search) ||
      Boolean(filter.types && filter.types.length > 0) ||
      Boolean(filter.sortBy);

    if (!isFilterActive) {
      if (typeof (this.cache as any).wrapFolderListing === 'function') {
        const cached = await (this.cache as any).wrapFolderListing(
          scopeKey,
          filter.parentId,
          () => this.nodeRepo.list(filter),
          120, // 2 minutes TTL
        );
        return {
          nodes: cached.nodes.map((n: any) =>
            n instanceof StorageNode ? n : new StorageNode(n),
          ),
          total: cached.total,
        };
      }

      const cached = await this.cache.getFolderListing<{
        nodes: any[];
        total: number;
      }>(scopeKey, filter.parentId);
      if (cached) {
        return {
          nodes: cached.nodes.map((n) => new StorageNode(n)),
          total: cached.total,
        };
      }
    }

    const result = await this.nodeRepo.list(filter);

    if (!isFilterActive) {
      await this.cache.setFolderListing(
        scopeKey,
        filter.parentId,
        result,
        120, // 2 minutes TTL
      );
    }

    return result;
  }
}
