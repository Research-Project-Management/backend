import { Injectable, Logger } from '@nestjs/common';
import { AttachmentsService } from '../services/attachments.service';
import { ReplaceAttachmentFileInput } from '../../domain/types/attachments.types';

export interface AddAttachmentRevisionCommand {
  userId: string;
  attachmentId: string;
  input: ReplaceAttachmentFileInput;
  projectId?: string;
}

@Injectable()
export class AddAttachmentRevisionUseCase {
  private readonly logger = new Logger(AddAttachmentRevisionUseCase.name);

  constructor(private readonly attachmentsService: AttachmentsService) {}

  async execute(command: AddAttachmentRevisionCommand) {
    this.logger.debug(
      `Adding revision to attachment ${command.attachmentId} for user ${command.userId}`,
    );
    return this.attachmentsService.addRevision(
      command.userId,
      command.attachmentId,
      command.input,
      command.projectId,
    );
  }
}
