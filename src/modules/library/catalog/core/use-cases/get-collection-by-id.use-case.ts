import { Injectable, Logger } from '@nestjs/common';
import { CollectionsService } from '../services/collections.service';

export interface GetCollectionByIdQuery {
  userId: string;
  collectionId: string;
  projectId?: string;
}

/**
 * Query Use Case — Get Collection By Id
 */
@Injectable()
export class GetCollectionByIdUseCase {
  private readonly logger = new Logger(GetCollectionByIdUseCase.name);

  constructor(private readonly collectionsService: CollectionsService) {}

  async execute(query: GetCollectionByIdQuery) {
    this.logger.debug(
      `Executing GetCollectionByIdUseCase for collection ${query.collectionId}`,
    );
    return this.collectionsService.getCollectionById(
      query.userId,
      query.collectionId,
      query.projectId,
    );
  }
}
