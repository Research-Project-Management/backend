import { Injectable, Logger } from '@nestjs/common';
import { CollectionsService } from '../services/collections.service';
import { AssignItemsToCollectionDto } from '../dtos/collections.dto';

export interface AssignItemsToCollectionCommand {
  userId: string;
  collectionId: string;
  dto: AssignItemsToCollectionDto;
  projectId?: string;
}

/**
 * Command Use Case — Assign Items To Collection
 */
@Injectable()
export class AssignItemsToCollectionUseCase {
  private readonly logger = new Logger(AssignItemsToCollectionUseCase.name);

  constructor(private readonly collectionsService: CollectionsService) {}

  async execute(command: AssignItemsToCollectionCommand) {
    this.logger.debug(
      `Executing AssignItemsToCollectionUseCase for collection ${command.collectionId}`,
    );
    return this.collectionsService.assignItemsToCollection(
      command.userId,
      command.collectionId,
      command.dto,
      command.projectId,
    );
  }
}
