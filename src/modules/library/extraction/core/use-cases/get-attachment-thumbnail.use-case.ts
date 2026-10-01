import { Injectable, Logger } from '@nestjs/common';
import { AttachmentsService } from '../services/attachments.service';

export interface GetAttachmentThumbnailQuery {
  userId: string;
  attachmentId: string;
  projectId?: string;
}

@Injectable()
export class GetAttachmentThumbnailUseCase {
  private readonly logger = new Logger(GetAttachmentThumbnailUseCase.name);

  constructor(private readonly attachmentsService: AttachmentsService) {}

  async execute(
    query: GetAttachmentThumbnailQuery,
  ): Promise<{ buffer: Buffer; mimeType: string }> {
    this.logger.debug(
      `Retrieving thumbnail for attachment ${query.attachmentId}`,
    );
    return this.attachmentsService.getThumbnail(
      query.userId,
      query.attachmentId,
      query.projectId,
    );
  }
}
