import { Injectable, Inject, Logger } from '@nestjs/common';
import {
  ATTACHMENT_REPOSITORY_PORT,
  IAttachmentRepositoryPort,
} from '../../domain/ports/attachment-repository.port';
import { AttachmentResultDto } from '../commands/create-attachment.use-case';

@Injectable()
export class GetAttachmentUseCase {
  private readonly logger = new Logger(GetAttachmentUseCase.name);

  constructor(
    @Inject(ATTACHMENT_REPOSITORY_PORT)
    private readonly attachmentRepo: IAttachmentRepositoryPort,
  ) {}

  async execute(attachmentId: string): Promise<AttachmentResultDto | null> {
    const aggregate = await this.attachmentRepo.findById(attachmentId);
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
