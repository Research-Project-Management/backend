import { Injectable, Logger } from '@nestjs/common';
import { CollectionsService } from '../services/collections.service';
import { CollectionDeleteStrategy } from '../../domain/types/collections.types';

export interface DeleteCollectionCommand {
  userId: string;
  collectionId: string;
  strategy?: CollectionDeleteStrategy;
  projectId?: string;
}

/**
 * Command Use Case — Delete Collection
 */
@Injectable()
export class DeleteCollectionUseCase {
  private readonly logger = new Logger(DeleteCollectionUseCase.name);

  constructor(private readonly collectionsService: CollectionsService) {}

  async execute(command: DeleteCollectionCommand) {
    this.logger.debug(
      `Executing DeleteCollectionUseCase for collection ${command.collectionId}`,
    );
    return this.collectionsService.deleteCollection(
      command.userId,
      command.collectionId,
      command.strategy,
      command.projectId,
    );
  }
}
