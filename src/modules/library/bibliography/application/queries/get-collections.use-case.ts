import { Injectable, Logger } from '@nestjs/common';
import { CollectionsService } from '../services/collections.service';

export interface GetCollectionsQuery {
  userId: string;
  projectId?: string;
}

/**
 * Query Use Case — Get Collections
 */
@Injectable()
export class GetCollectionsUseCase {
  private readonly logger = new Logger(GetCollectionsUseCase.name);

  constructor(private readonly collectionsService: CollectionsService) {}

  async execute(query: GetCollectionsQuery) {
    this.logger.debug(
      `Executing GetCollectionsUseCase for user ${query.userId}`,
    );
    return this.collectionsService.getCollections(
      query.userId,
      query.projectId,
    );
  }
}
