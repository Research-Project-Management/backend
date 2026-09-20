import { Injectable, Inject, Optional, Logger } from '@nestjs/common';
import { AttachmentAggregate } from '../../domain/model/attachment.aggregate';
import {
  ATTACHMENT_REPOSITORY_PORT,
  IAttachmentRepositoryPort,
} from '../../domain/ports/attachment-repository.port';
import { AttachmentsService } from '../services/attachments.service';
import { CreateAttachmentInput } from '../../domain/types/attachments.types';

export interface CreateAttachmentCommand {
  itemId: string;
  filename: string;
  url: string;
  mimeType?: string | null;
  sizeBytes?: number;
  fileHash?: string | null;
}

export interface AttachmentResultDto {
  id: string;
  itemId: string;
  filename: string;
  url: string;
  mimeType: string;
  sizeBytes: number;
  fileHash: string | null;
  revisionCount: number;
  isExtracted: boolean;
  pageCount?: number | null;
}

@Injectable()
export class CreateAttachmentUseCase {
  private readonly logger = new Logger(CreateAttachmentUseCase.name);

  constructor(
    @Inject(ATTACHMENT_REPOSITORY_PORT)
    private readonly attachmentRepo: IAttachmentRepositoryPort,
    @Optional()
    private readonly attachmentsService?: AttachmentsService,
  ) {}

  async execute(command: CreateAttachmentCommand): Promise<AttachmentResultDto>;
  async execute(input: CreateAttachmentInput, projectId?: string): Promise<any>;
  async execute(first: any, second?: string): Promise<any> {
    if (this.attachmentsService && (first.userId || second !== undefined)) {
      return this.attachmentsService.createAttachment(first, second);
    }

    this.logger.debug(`Creating attachment for item ${first.itemId}`);

    const aggregate = AttachmentAggregate.create({
      itemId: first.itemId,
      filename: first.filename,
      url: first.url,
      mimeType: first.mimeType,
      sizeBytes: first.sizeBytes ?? first.size,
      fileHash: first.fileHash,
    });

    await this.attachmentRepo.save(aggregate);

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
