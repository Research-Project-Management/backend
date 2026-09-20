import { Inject, Injectable } from '@nestjs/common';
import {
  COLLECTION_REPOSITORY_PORT,
  ICollectionRepositoryPort,
  CollectionDto,
} from '../../../domain/ports/collection-repository.port';

export interface ListCollectionsQuery {
  userId: string;
  projectId?: string;
}

/**
 * Query Use Case — List Collections (flat list for tree building in the adapter layer)
 */
@Injectable()
export class ListCollectionsUseCase {
  constructor(
    @Inject(COLLECTION_REPOSITORY_PORT)
    private readonly collectionRepo: ICollectionRepositoryPort,
  ) {}

  async execute(query: ListCollectionsQuery): Promise<CollectionDto[]> {
    return this.collectionRepo.findAll(query.userId, query.projectId);
  }
}
