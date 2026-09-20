import { Injectable, Logger } from '@nestjs/common';
import { CollectionsService } from '../services/collections.service';
import { CollectionTreeNode } from '../../domain/types/collections.types';

export interface GetCollectionTreeQuery {
  userId: string;
  projectId?: string;
}

/**
 * Query Use Case — Get Collection Tree
 */
@Injectable()
export class GetCollectionTreeUseCase {
  private readonly logger = new Logger(GetCollectionTreeUseCase.name);

  constructor(private readonly collectionsService: CollectionsService) {}

  async execute(
    query: GetCollectionTreeQuery,
  ): Promise<{ tree: CollectionTreeNode[] }> {
    this.logger.debug(
      `Executing GetCollectionTreeUseCase for user ${query.userId}`,
    );
    return this.collectionsService.getCollectionTree(
      query.userId,
      query.projectId,
    );
  }
}
