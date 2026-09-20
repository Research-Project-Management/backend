import { Injectable, Inject, NotFoundException, Logger } from '@nestjs/common';
import {
  ITEM_REPOSITORY_PORT,
  IItemRepositoryPort,
} from '../../domain/ports/item-repository.port';
import { TagsService } from '../services/tags.service';

export interface PurgeItemCommand {
  userId: string;
  itemId: string;
  projectId?: string;
}

@Injectable()
export class PurgeItemUseCase {
  private readonly logger = new Logger(PurgeItemUseCase.name);

  constructor(
    @Inject(ITEM_REPOSITORY_PORT)
    private readonly itemRepo: IItemRepositoryPort,
    private readonly tagsService: TagsService,
  ) {}

  async execute(command: PurgeItemCommand): Promise<boolean> {
    const { userId, itemId, projectId } = command;
    this.logger.log(`Purging item ${itemId} for user ${userId}`);

    const existing = await this.itemRepo.findById(userId, itemId, projectId);
    if (!existing) {
      throw new NotFoundException(`Item ${itemId} not found`);
    }

    const purged = await this.itemRepo.purge(userId, itemId, projectId);
    await this.tagsService.invalidateTagsCache(userId, projectId);
    return purged;
  }
}
