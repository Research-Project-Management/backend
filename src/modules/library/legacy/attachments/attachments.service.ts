import { Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { ExtractorService } from './extractor.service';

import { ItemsRepository } from '../items/items.repository';

@Injectable()
export class AttachmentsService {
  constructor(
    private readonly pdfExtractorService: ExtractorService,
    private readonly itemsRepo: ItemsRepository,
  ) {}

  /**
   * Extract metadata identifiers from a PDF file URL
   */
  async extractFromPdf(fileUrl: string) {
    return this.pdfExtractorService.extractMetadataFromUrl(fileUrl);
  }

  /**
   * Calculates SHA-256 fingerprint of a file content or buffer
   */
  calculateFileHash(content: Buffer | string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  async getItemAttachments(workspaceId: string, itemId: string) {
    const item = await this.getItemInWorkspace(workspaceId, itemId);
    return {
      itemId: item.id,
      attachments: item.attachments ?? [],
      total: item.attachments?.length ?? 0,
    };
  }

  async getItemAttachment(
    workspaceId: string,
    itemId: string,
    attachmentId: string,
  ) {
    const item = await this.getItemInWorkspace(workspaceId, itemId);
    const attachment = item.attachments?.find(
      (candidate: any) => candidate.id === attachmentId,
    );

    if (!attachment) {
      throw new NotFoundException('Attachment not found for this catalog item');
    }

    return { attachment };
  }

  async addAttachment(
    workspaceId: string,
    itemId: string,
    data: {
      filename: string;
      mimeType: string;
      size: number;
      url: string;
      content?: Buffer | string;
      storageKey?: string;
    },
  ) {
    const item = await this.getItemInWorkspace(workspaceId, itemId);
    const hash = data.content
      ? this.calculateFileHash(data.content)
      : undefined;
    const now = new Date().toISOString();

    const attachmentId = randomUUID();
    const newAttachment = {
      id: attachmentId,
      filename: data.filename,
      mimeType: data.mimeType,
      size: data.size,
      url: data.url,
      storageKey:
        data.storageKey || `attachments/${attachmentId}/${data.filename}`,
      fileHash: hash,
      version: 1,
      createdAt: now,
      updatedAt: now,
      revisions: [
        {
          id: randomUUID(),
          revisionNumber: 1,
          fileHash: hash,
          size: data.size,
          url: data.url,
          createdAt: now,
        },
      ],
    };

    await this.itemsRepo.updateItem(item.id, {
      attachments: {
        create: {
          id: attachmentId,
          filename: data.filename,
          mimeType: data.mimeType,
          size: data.size,
          url: data.url,
          attachmentType: 'pdf' as any,
        },
      },
    });

    return { attachment: newAttachment };
  }

  private async getItemInWorkspace(workspaceId: string, itemId: string) {
    const targetWsId = await this.itemsRepo.resolveWorkspaceId(workspaceId);
    const item = await this.itemsRepo.findItemByIdInWorkspace(
      targetWsId,
      itemId,
    );

    if (!item || item.deletedAt) {
      throw new NotFoundException('Catalog item not found in this workspace');
    }

    return item;
  }
}
