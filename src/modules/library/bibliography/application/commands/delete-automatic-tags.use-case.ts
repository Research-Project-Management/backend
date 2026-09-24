import { Injectable, Logger } from '@nestjs/common';
import { TagsService } from '../services/tags.service';

export interface DeleteAutomaticTagsCommand {
  userId: string;
  projectId?: string;
}

/**
 * Command Use Case — Delete Automatic Tags
 */
@Injectable()
export class DeleteAutomaticTagsUseCase {
  private readonly logger = new Logger(DeleteAutomaticTagsUseCase.name);

  constructor(private readonly tagsService: TagsService) {}

  async execute(
    command: DeleteAutomaticTagsCommand,
  ): Promise<{ count: number }> {
    this.logger.debug(
      `Executing DeleteAutomaticTagsUseCase for user ${command.userId}`,
    );
    return this.tagsService.deleteAutomaticTags(
      command.userId,
      command.projectId,
    );
  }
}
