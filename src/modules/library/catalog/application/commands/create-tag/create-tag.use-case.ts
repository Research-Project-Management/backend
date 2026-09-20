import { Inject, Injectable } from '@nestjs/common';
import {
  TAG_REPOSITORY_PORT,
  ITagRepositoryPort,
  TagDto,
  CreateTagOptions,
} from '../../../domain/ports/tag-repository.port';

export interface CreateTagCommand {
  userId: string;
  name: string;
  options?: CreateTagOptions;
}

/**
 * Command Use Case — Create or Get Tag
 *
 * Application layer: creates a tag (or returns existing one with same name).
 * Depends ONLY on ITagRepositoryPort (Domain interface).
 * Zero imports from @nestjs HTTP, @prisma, or any infrastructure detail.
 */
@Injectable()
export class CreateTagUseCase {
  constructor(
    @Inject(TAG_REPOSITORY_PORT)
    private readonly tagRepo: ITagRepositoryPort,
  ) {}

  async execute(command: CreateTagCommand): Promise<TagDto> {
    return this.tagRepo.createOrGet(
      command.userId,
      command.name,
      command.options,
    );
  }
}
