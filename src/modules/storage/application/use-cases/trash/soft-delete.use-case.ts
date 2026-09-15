import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { STORAGE_NODE_REPOSITORY } from '../../../storage.tokens';
import { IStorageNodeRepository } from '../../../domain/ports/storage-node.repository.port';
import { StorageRedisCacheService } from '../../../infrastructure/cache/storage-redis-cache.service';
import { FileTrashedEvent } from '../../../domain/events/file-trashed.event';

@Injectable()
export class SoftDeleteUseCase {
  constructor(
    @Inject(STORAGE_NODE_REPOSITORY)
    private readonly nodeRepo: IStorageNodeRepository,
    private readonly cache: StorageRedisCacheService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async execute(nodeId: string): Promise<number> {
    const node = await this.nodeRepo.findById(nodeId);
    if (!node) {
      throw new NotFoundException('Node not found');
    }

    // Cascading soft-delete subtree via recursive CTE in 1 atomic query
    const affectedCount = await this.nodeRepo.softDeleteSubtree(nodeId);

    // Invalidate parent cache
    const scopeKey = node.projectId ?? node.authorId;
    await this.cache.invalidateFolder(scopeKey, node.parentId);

    this.eventEmitter.emit(
      'file.trashed',
      new FileTrashedEvent(node.id, node.authorId, new Date(), node.projectId),
    );

    return affectedCount;
  }
}
