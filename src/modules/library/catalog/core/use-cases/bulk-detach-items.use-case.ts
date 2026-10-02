import { Injectable, Logger } from '@nestjs/common';
import { CollectionsService } from '../services/collections.service';

export interface BulkDetachItemsCommand {
  userId: string;
  collectionId: string;
  itemIds: string[];
  projectId?: string;
}

/**
 * Command Use Case — Bulk Detach Multiple Items From Collection
 */
@Injectable()
export class BulkDetachItemsUseCase {
  private readonly logger = new Logger(BulkDetachItemsUseCase.name);

  constructor(private readonly collectionsService: CollectionsService) {}

  async execute(command: BulkDetachItemsCommand) {
    this.logger.debug(
      `Executing BulkDetachItemsUseCase for ${command.itemIds.length} items in collection ${command.collectionId}`,
    );
    return this.collectionsService.detachItemsFromCollection(
      command.userId,
      command.collectionId,
      command.itemIds,
      command.projectId,
    );
  }
}
