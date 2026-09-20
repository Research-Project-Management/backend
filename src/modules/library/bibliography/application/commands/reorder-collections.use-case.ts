import { Injectable, Logger } from '@nestjs/common';
import { CollectionsService } from '../services/collections.service';

export interface ReorderCollectionsCommand {
  userId: string;
  collections: Array<{
    id: string;
    orderIndex?: number;
    parentId?: string | null;
  }>;
  projectId?: string;
}

/**
 * Command Use Case — Reorder Collections
 */
@Injectable()
export class ReorderCollectionsUseCase {
  private readonly logger = new Logger(ReorderCollectionsUseCase.name);

  constructor(private readonly collectionsService: CollectionsService) {}

  async execute(command: ReorderCollectionsCommand) {
    this.logger.debug(
      `Executing ReorderCollectionsUseCase for user ${command.userId}`,
    );
    return this.collectionsService.reorderCollections(
      command.userId,
      command.collections,
      command.projectId,
    );
  }
}
