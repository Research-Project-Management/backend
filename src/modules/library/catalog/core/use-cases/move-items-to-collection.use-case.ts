import { Injectable, Logger } from '@nestjs/common';
import { CollectionsService } from '../services/collections.service';

export interface MoveItemsToCollectionCommand {
  userId: string;
  collectionId: string;
  itemIds: string[];
  projectId?: string;
}

/**
 * Command Use Case — Move Items To Collection
 */
@Injectable()
export class MoveItemsToCollectionUseCase {
  private readonly logger = new Logger(MoveItemsToCollectionUseCase.name);

  constructor(private readonly collectionsService: CollectionsService) {}

  async execute(command: MoveItemsToCollectionCommand) {
    this.logger.debug(
      `Executing MoveItemsToCollectionUseCase for collection ${command.collectionId} (${command.itemIds.length} items)`,
    );
    return this.collectionsService.moveItems(
      command.userId,
      command.collectionId,
      command.itemIds,
      command.projectId,
    );
  }
}
