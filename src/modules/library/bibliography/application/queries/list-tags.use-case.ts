import { Inject, Injectable } from '@nestjs/common';
import {
  TAG_REPOSITORY_PORT,
  ITagRepositoryPort,
  TagDto,
  FindTagsOptions,
} from '../../domain/ports/tag-repository.port';

export interface ListTagsQuery {
  userId: string;
  options?: FindTagsOptions;
}

/**
 * Query Use Case — List Tags
 *
 * Application layer: orchestrates the fetch of tags for a user/project scope.
 * Depends ONLY on ITagRepositoryPort (Domain interface).
 * Zero imports from @nestjs, @prisma, or any infrastructure detail.
 */
@Injectable()
export class ListTagsUseCase {
  constructor(
    @Inject(TAG_REPOSITORY_PORT)
    private readonly tagRepo: ITagRepositoryPort,
  ) {}

  async execute(query: ListTagsQuery): Promise<TagDto[]> {
    return this.tagRepo.findMany(query.userId, query.options);
  }
}
