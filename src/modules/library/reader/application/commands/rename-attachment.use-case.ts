import { Injectable, Logger } from '@nestjs/common';
import { AttachmentsService } from '../services/attachments.service';
import { RenameAttachmentDto } from '../dtos/attachments.dto';

export interface RenameAttachmentCommand {
  userId: string;
  attachmentId: string;
  dto: RenameAttachmentDto;
  projectId?: string;
}

@Injectable()
export class RenameAttachmentUseCase {
  private readonly logger = new Logger(RenameAttachmentUseCase.name);

  constructor(private readonly attachmentsService: AttachmentsService) {}

  async execute(command: RenameAttachmentCommand) {
    this.logger.debug(
      `Renaming attachment ${command.attachmentId} for user ${command.userId}`,
    );
    return this.attachmentsService.renameAttachment(
      command.userId,
      command.attachmentId,
      command.dto,
      command.projectId,
    );
  }
}
