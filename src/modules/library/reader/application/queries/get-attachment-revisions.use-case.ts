import { Injectable, Logger } from '@nestjs/common';
import { AttachmentsService } from '../services/attachments.service';

export interface GetAttachmentRevisionsQuery {
  userId: string;
  attachmentId: string;
  projectId?: string;
}

@Injectable()
export class GetAttachmentRevisionsUseCase {
  private readonly logger = new Logger(GetAttachmentRevisionsUseCase.name);

  constructor(private readonly attachmentsService: AttachmentsService) {}

  async execute(query: GetAttachmentRevisionsQuery) {
    this.logger.debug(
      `Retrieving revisions for attachment ${query.attachmentId}`,
    );
    return this.attachmentsService.getRevisions(
      query.userId,
      query.attachmentId,
      query.projectId,
    );
  }
}
