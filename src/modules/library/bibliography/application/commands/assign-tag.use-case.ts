import { Injectable, Logger } from '@nestjs/common';
import { TagsService } from '../services/tags.service';

export interface AssignTagCommand {
  userId: string;
  tagId: string;
  itemId: string;
}

/**
 * Command Use Case — Assign Tag
 */
@Injectable()
export class AssignTagUseCase {
  private readonly logger = new Logger(AssignTagUseCase.name);

  constructor(private readonly tagsService: TagsService) {}

  async execute(command: AssignTagCommand): Promise<{ success: boolean }> {
    this.logger.debug(
      `Executing AssignTagUseCase for tag ${command.tagId} to item ${command.itemId}`,
    );
    await this.tagsService.assignTag(
      command.userId,
      command.tagId,
      command.itemId,
    );
    return { success: true };
  }
}
