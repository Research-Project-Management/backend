import { Injectable, Logger } from '@nestjs/common';
import { CollectionsService } from '../services/collections.service';

export interface DetachItemFromCollectionCommand {
  userId: string;
  collectionId: string;
  itemId: string;
  projectId?: string;
}

/**
 * Command Use Case — Detach Item From Collection
 */
@Injectable()
export class DetachItemFromCollectionUseCase {
  private readonly logger = new Logger(DetachItemFromCollectionUseCase.name);

  constructor(private readonly collectionsService: CollectionsService) {}

  async execute(command: DetachItemFromCollectionCommand) {
    this.logger.debug(
      `Executing DetachItemFromCollectionUseCase for item ${command.itemId} in collection ${command.collectionId}`,
    );
    return this.collectionsService.detachItemFromCollection(
      command.userId,
      command.collectionId,
      command.itemId,
      command.projectId,
    );
  }
}
