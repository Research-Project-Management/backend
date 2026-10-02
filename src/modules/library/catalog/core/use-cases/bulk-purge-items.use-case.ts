import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import {
  ITEM_REPOSITORY_PORT,
  IItemRepositoryPort,
} from '../ports/item-repository.port';
import {
  PROJECT_ACCESS_PORT,
  IProjectAccessPort,
} from '../ports/project-access.port';
import { TagsService } from '../services/tags.service';

export interface BulkPurgeItemsCommand {
  userId: string;
  itemIds: string[];
  projectId?: string;
}

@Injectable()
export class BulkPurgeItemsUseCase {
  private readonly logger = new Logger(BulkPurgeItemsUseCase.name);

  constructor(
    @Inject(ITEM_REPOSITORY_PORT)
    private readonly itemRepo: IItemRepositoryPort,
    private readonly tagsService: TagsService,
    @Optional()
    @Inject(PROJECT_ACCESS_PORT)
    private readonly projectAccessPort?: IProjectAccessPort,
  ) {}

  async execute(command: BulkPurgeItemsCommand): Promise<{
    success: boolean;
    count: number;
    purgedIds: string[];
  }> {
    const { userId, itemIds, projectId } = command;
    if (!itemIds || itemIds.length === 0) {
      return { success: true, count: 0, purgedIds: [] };
    }
    this.logger.log(`Bulk purging ${itemIds.length} items for user ${userId}`);

    const purgedIds: string[] = [];
    for (const itemId of itemIds) {
      try {
        const existing = await this.itemRepo.findById(
          userId,
          itemId,
          projectId,
          true,
        );
        if (!existing) continue;

        if (existing.projectId) {
          if (!projectId || projectId !== existing.projectId) continue;
          if (this.projectAccessPort) {
            const isOwner = await this.projectAccessPort.isProjectOwner(
              userId,
              existing.projectId,
            );
            if (!isOwner) continue;
          }
        }

        const purged = await this.itemRepo.purge(userId, itemId, projectId);
        if (purged) {
          purgedIds.push(itemId);
        }
      } catch (err: unknown) {
        this.logger.warn(
          `Failed to purge item ${itemId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    await this.tagsService.invalidateTagsCache(userId, projectId);
    return { success: true, count: purgedIds.length, purgedIds };
  }
}
