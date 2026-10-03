import { Injectable, Inject, Logger } from '@nestjs/common';
import {
  ITEM_REPOSITORY_PORT,
  IItemRepositoryPort,
} from '../ports/item-repository.port';
import { TagsService } from '../services/tags.service';

export interface BulkTrashItemsCommand {
  userId: string;
  itemIds: string[];
  projectId?: string;
}

@Injectable()
export class BulkTrashItemsUseCase {
  private readonly logger = new Logger(BulkTrashItemsUseCase.name);

  constructor(
    @Inject(ITEM_REPOSITORY_PORT)
    private readonly itemRepo: IItemRepositoryPort,
    private readonly tagsService: TagsService,
  ) {}

  async execute(command: BulkTrashItemsCommand): Promise<{
    success: boolean;
    count: number;
    trashedIds: string[];
  }> {
    const { userId, itemIds, projectId } = command;
    if (!itemIds || itemIds.length === 0) {
      return { success: true, count: 0, trashedIds: [] };
    }
    this.logger.log(
      `Bulk moving ${itemIds.length} items to trash for user ${userId}`,
    );

    const trashedIds: string[] = [];
    for (const itemId of itemIds) {
      try {
        const aggregate = await this.itemRepo.findById(
          userId,
          itemId,
          projectId ?? undefined,
        );
        if (!aggregate) continue;

        aggregate.softDelete();
        await this.itemRepo.save(aggregate);
        trashedIds.push(itemId);
      } catch (err: unknown) {
        this.logger.warn(
          `Failed to move item ${itemId} to trash: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    await this.tagsService.invalidateTagsCache(userId, projectId);
    return { success: true, count: trashedIds.length, trashedIds };
  }
}
