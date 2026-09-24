import { Injectable, Logger } from '@nestjs/common';
import { TagsService } from '../services/tags.service';

export interface DeleteTagCommand {
  userId: string;
  tagId: string;
  projectId?: string;
}

/**
 * Command Use Case — Delete Tag
 */
@Injectable()
export class DeleteTagUseCase {
  private readonly logger = new Logger(DeleteTagUseCase.name);

  constructor(private readonly tagsService: TagsService) {}

  async execute(command: DeleteTagCommand): Promise<boolean> {
    this.logger.debug(`Executing DeleteTagUseCase for tag ${command.tagId}`);
    return this.tagsService.deleteTag(
      command.userId,
      command.tagId,
      command.projectId,
    );
  }
}
