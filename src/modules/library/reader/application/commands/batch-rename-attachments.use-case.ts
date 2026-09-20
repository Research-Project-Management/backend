import { Injectable, Logger } from '@nestjs/common';
import { AttachmentsService } from '../services/attachments.service';
import { BatchRenameAttachmentsDto } from '../dtos/attachments.dto';

export interface BatchRenameAttachmentsCommand {
  userId: string;
  dto: BatchRenameAttachmentsDto;
  projectId?: string;
}

@Injectable()
export class BatchRenameAttachmentsUseCase {
  private readonly logger = new Logger(BatchRenameAttachmentsUseCase.name);

  constructor(private readonly attachmentsService: AttachmentsService) {}

  async execute(command: BatchRenameAttachmentsCommand) {
    this.logger.debug(`Batch renaming attachments for user ${command.userId}`);
    return this.attachmentsService.batchRenameAttachments(
      command.userId,
      command.dto,
      command.projectId,
    );
  }
}
