import {
  Injectable,
  Inject,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { STORAGE_NODE_REPOSITORY } from '../../../storage.tokens';
import { IStorageNodeRepository } from '../../../domain/ports/storage-node.repository.port';
import { StorageRedisCacheService } from '../../../infrastructure/cache/storage-redis-cache.service';
import { StorageNode } from '../../../domain/entities/storage-node.entity';

@Injectable()
export class MoveNodeUseCase {
  constructor(
    @Inject(STORAGE_NODE_REPOSITORY)
    private readonly nodeRepo: IStorageNodeRepository,
    private readonly cache: StorageRedisCacheService,
  ) {}

  async execute(
    nodeId: string,
    newParentId: string | null,
  ): Promise<StorageNode> {
    const node = await this.nodeRepo.findById(nodeId);
    if (!node || node.isTrashed()) {
      throw new NotFoundException('Node not found or is in trash');
    }

    const oldParentId = node.parentId;

    // Validate target parent exists and is a folder
    if (newParentId) {
      if (newParentId === nodeId) {
        throw new BadRequestException('Cannot move a folder into itself');
      }
      const targetParent = await this.nodeRepo.findById(newParentId);
      if (!targetParent || !targetParent.isFolder) {
        throw new BadRequestException(
          'Target parent folder does not exist or is not a folder',
        );
      }

      // If moving a folder, ensure target parent is not a descendant of this folder
      if (node.isFolder) {
        let curr: StorageNode | null = targetParent;
        const visited = new Set<string>([nodeId]);
        while (curr && curr.parentId) {
          if (visited.has(curr.parentId)) {
            throw new BadRequestException(
              'Cannot move a folder into its own subfolder (circular hierarchy detected)',
            );
          }
          visited.add(curr.parentId);
          curr = await this.nodeRepo.findById(curr.parentId);
        }
      }
    }

    node.moveTo(newParentId);
    const updated = await this.nodeRepo.update(node);

    // Invalidate caches of both old and new folders
    const scopeKey = node.projectId ?? node.authorId;
    await this.cache.invalidateFolder(scopeKey, oldParentId);
    await this.cache.invalidateFolder(scopeKey, newParentId);

    return updated;
  }
}
