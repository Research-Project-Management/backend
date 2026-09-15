import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { STORAGE_NODE_REPOSITORY } from '../../../storage.tokens';
import { IStorageNodeRepository } from '../../../domain/ports/storage-node.repository.port';
import { StorageRedisCacheService } from '../../../infrastructure/cache/storage-redis-cache.service';

@Injectable()
export class RestoreNodeUseCase {
  constructor(
    @Inject(STORAGE_NODE_REPOSITORY)
    private readonly nodeRepo: IStorageNodeRepository,
    private readonly cache: StorageRedisCacheService,
  ) {}

  async execute(nodeId: string): Promise<number> {
    const node = await this.nodeRepo.findById(nodeId);
    if (!node) {
      throw new NotFoundException('Node not found');
    }

    const restoredCount = await this.nodeRepo.restoreSubtree(nodeId);
    const scopeKey = node.projectId ?? node.authorId;
    await this.cache.invalidateFolder(scopeKey, node.parentId);
    return restoredCount;
  }
}
