import { Injectable, Logger } from '@nestjs/common';
import { TagsService } from '../services/tags.service';

export interface DetachTagCommand {
  userId: string;
  tagId: string;
  itemId: string;
}

/**
 * Command Use Case — Detach Tag
 */
@Injectable()
export class DetachTagUseCase {
  private readonly logger = new Logger(DetachTagUseCase.name);

  constructor(private readonly tagsService: TagsService) {}

  async execute(command: DetachTagCommand): Promise<{ success: boolean }> {
    this.logger.debug(
      `Executing DetachTagUseCase for tag ${command.tagId} from item ${command.itemId}`,
    );
    await this.tagsService.removeTag(
      command.userId,
      command.tagId,
      command.itemId,
    );
    return { success: true };
  }
}
