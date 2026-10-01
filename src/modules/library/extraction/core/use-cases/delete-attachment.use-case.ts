import { Injectable, Logger } from '@nestjs/common';
import { AttachmentsService } from '../services/attachments.service';

export interface DeleteAttachmentCommand {
  userId: string;
  attachmentId: string;
  projectId?: string;
}

@Injectable()
export class DeleteAttachmentUseCase {
  private readonly logger = new Logger(DeleteAttachmentUseCase.name);

  constructor(private readonly attachmentsService: AttachmentsService) {}

  async execute(command: DeleteAttachmentCommand) {
    this.logger.debug(
      `Deleting attachment ${command.attachmentId} for user ${command.userId}`,
    );
    return this.attachmentsService.deleteAttachment(
      command.userId,
      command.attachmentId,
      command.projectId,
    );
  }
}
