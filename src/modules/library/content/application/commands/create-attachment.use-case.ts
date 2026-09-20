import { Injectable, Inject, Logger } from '@nestjs/common';
import { AttachmentAggregate } from '../../domain/model/attachment.aggregate';
import {
  ATTACHMENT_REPOSITORY_PORT,
  IAttachmentRepositoryPort,
} from '../../domain/ports/attachment-repository.port';

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
  ) {}

  async execute(
    command: CreateAttachmentCommand,
  ): Promise<AttachmentResultDto> {
    this.logger.debug(`Creating attachment for item ${command.itemId}`);

    const aggregate = AttachmentAggregate.create({
      itemId: command.itemId,
      filename: command.filename,
      url: command.url,
      mimeType: command.mimeType,
      sizeBytes: command.sizeBytes,
      fileHash: command.fileHash,
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
