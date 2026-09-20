import { Inject, Injectable } from '@nestjs/common';
import {
  COLLECTION_REPOSITORY_PORT,
  ICollectionRepositoryPort,
  CollectionDto,
  CreateCollectionData,
} from '../../domain/ports/collection-repository.port';

export type CreateCollectionCommand = CreateCollectionData;

/**
 * Command Use Case — Create Collection
 */
@Injectable()
export class CreateCollectionUseCase {
  constructor(
    @Inject(COLLECTION_REPOSITORY_PORT)
    private readonly collectionRepo: ICollectionRepositoryPort,
  ) {}

  async execute(command: CreateCollectionCommand): Promise<CollectionDto> {
    return this.collectionRepo.create(command);
  }
}
