import { Injectable, Logger } from '@nestjs/common';
import { AttachmentsService } from '../services/attachments.service';

export interface SetPrimaryAttachmentCommand {
  userId: string;
  itemId: string;
  attachmentId: string;
  projectId?: string;
}

@Injectable()
export class SetPrimaryAttachmentUseCase {
  private readonly logger = new Logger(SetPrimaryAttachmentUseCase.name);

  constructor(private readonly attachmentsService: AttachmentsService) {}

  async execute(command: SetPrimaryAttachmentCommand) {
    this.logger.debug(
      `Setting attachment ${command.attachmentId} as primary for item ${command.itemId}`,
    );
    return this.attachmentsService.setPrimaryAttachment(
      command.userId,
      command.itemId,
      command.attachmentId,
      command.projectId,
    );
  }
}
