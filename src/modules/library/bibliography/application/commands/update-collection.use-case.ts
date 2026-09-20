import { Injectable, Logger } from '@nestjs/common';
import { CollectionsService } from '../services/collections.service';
import { UpdateCollectionDto } from '../dtos/collections.dto';

export interface UpdateCollectionCommand {
  userId: string;
  collectionId: string;
  dto: UpdateCollectionDto;
  projectId?: string;
}

/**
 * Command Use Case — Update Collection
 */
@Injectable()
export class UpdateCollectionUseCase {
  private readonly logger = new Logger(UpdateCollectionUseCase.name);

  constructor(private readonly collectionsService: CollectionsService) {}

  async execute(command: UpdateCollectionCommand) {
    this.logger.debug(
      `Executing UpdateCollectionUseCase for collection ${command.collectionId}`,
    );
    return this.collectionsService.updateCollection(
      command.userId,
      command.collectionId,
      command.dto,
      command.projectId,
    );
  }
}
