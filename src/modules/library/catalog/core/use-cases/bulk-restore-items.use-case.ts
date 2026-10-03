import { Injectable, Inject, Logger } from '@nestjs/common';
import {
  ITEM_REPOSITORY_PORT,
  IItemRepositoryPort,
} from '../ports/item-repository.port';
import { TagsService } from '../services/tags.service';

export interface BulkRestoreItemsCommand {
  userId: string;
  itemIds: string[];
  projectId?: string;
}

@Injectable()
export class BulkRestoreItemsUseCase {
  private readonly logger = new Logger(BulkRestoreItemsUseCase.name);

  constructor(
    @Inject(ITEM_REPOSITORY_PORT)
    private readonly itemRepo: IItemRepositoryPort,
    private readonly tagsService: TagsService,
  ) {}

  async execute(command: BulkRestoreItemsCommand): Promise<{
    success: boolean;
    count: number;
    restoredIds: string[];
  }> {
    const { userId, itemIds, projectId } = command;
    if (!itemIds || itemIds.length === 0) {
      return { success: true, count: 0, restoredIds: [] };
    }
    this.logger.log(
      `Bulk restoring ${itemIds.length} items from trash for user ${userId}`,
    );

    const restoredIds: string[] = [];
    for (const itemId of itemIds) {
      try {
        const aggregate = await this.itemRepo.findById(
          userId,
          itemId,
          projectId ?? undefined,
          true,
        );
        if (!aggregate) continue;

        aggregate.restore();
        await this.itemRepo.save(aggregate);
        restoredIds.push(itemId);
      } catch (err: unknown) {
        this.logger.warn(
          `Failed to restore item ${itemId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    await this.tagsService.invalidateTagsCache(userId, projectId);
    return { success: true, count: restoredIds.length, restoredIds };
  }
}
