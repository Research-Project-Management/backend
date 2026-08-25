import { Injectable, NotFoundException } from '@nestjs/common';
import { CatalogRepository } from '../catalog/catalog.repository';
import { PdfExtractorService } from './pdf-extractor.service';

@Injectable()
export class AttachmentsService {
  constructor(
    private readonly pdfExtractorService: PdfExtractorService,
    private readonly catalogRepo: CatalogRepository,
  ) {}

  /**
   * Extract metadata identifiers from a PDF file URL
   */
  async extractFromPdf(fileUrl: string) {
    return this.pdfExtractorService.extractMetadataFromUrl(fileUrl);
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
      (candidate) => candidate.id === attachmentId,
    );

    if (!attachment) {
      throw new NotFoundException('Attachment not found for this catalog item');
    }

    return { attachment };
  }

  private async getItemInWorkspace(workspaceId: string, itemId: string) {
    const targetWsId = await this.catalogRepo.resolveWorkspaceId(workspaceId);
    const item = await this.catalogRepo.findItemByIdInWorkspace(
      targetWsId,
      itemId,
    );

    if (!item || item.deletedAt) {
      throw new NotFoundException('Catalog item not found in this workspace');
    }

    return item;
  }
}
