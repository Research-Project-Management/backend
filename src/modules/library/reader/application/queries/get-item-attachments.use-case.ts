import { Injectable, Logger } from '@nestjs/common';
import { AttachmentsService } from '../services/attachments.service';

export interface GetItemAttachmentsQuery {
  userId: string;
  itemId: string;
  projectId?: string;
}

@Injectable()
export class GetItemAttachmentsUseCase {
  private readonly logger = new Logger(GetItemAttachmentsUseCase.name);

  constructor(private readonly attachmentsService: AttachmentsService) {}

  async execute(query: GetItemAttachmentsQuery) {
    this.logger.debug(`Retrieving attachments for item ${query.itemId}`);
    return this.attachmentsService.getItemAttachments(
      query.userId,
      query.itemId,
      query.projectId,
    );
  }
}
