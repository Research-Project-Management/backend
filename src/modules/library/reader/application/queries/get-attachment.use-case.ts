import { Injectable, Inject, Optional, Logger } from '@nestjs/common';
import {
  ATTACHMENT_REPOSITORY_PORT,
  IAttachmentRepositoryPort,
} from '../../domain/ports/attachment-repository.port';
import { AttachmentResultDto } from '../commands/create-attachment.use-case';
import { AttachmentsService } from '../services/attachments.service';

@Injectable()
export class GetAttachmentUseCase {
  private readonly logger = new Logger(GetAttachmentUseCase.name);

  constructor(
    @Inject(ATTACHMENT_REPOSITORY_PORT)
    private readonly attachmentRepo: IAttachmentRepositoryPort,
    @Optional()
    private readonly attachmentsService?: AttachmentsService,
  ) {}

  async execute(attachmentId: string): Promise<AttachmentResultDto | null>;
  async execute(
    userId: string,
    itemId: string | undefined,
    attachmentId: string,
    projectId?: string,
  ): Promise<any>;
  async execute(
    first: string,
    second?: string,
    third?: string,
    fourth?: string,
  ): Promise<any> {
    if (third !== undefined) {
      const userId = first;
      const itemId = second;
      const attachmentId = third;
      const projectId = fourth;
      if (this.attachmentsService) {
        return this.attachmentsService.getItemAttachment(
          userId,
          itemId,
          attachmentId,
          projectId,
        );
      }
    }

    const aggregate = await this.attachmentRepo.findById(first);
    if (!aggregate) return null;

    return {
      id: aggregate.id,
      itemId: aggregate.itemId,
      filename: aggregate.filename,
      url: aggregate.url,
      mimeType: aggregate.mimeType,
      sizeBytes: aggregate.sizeBytes,
      fileHash: aggregate.fileHash,
      revisionCount: aggregate.revisionCount,
      isExtracted: aggregate.isExtracted,
      pageCount: aggregate.pageCount,
    };
  }
}
