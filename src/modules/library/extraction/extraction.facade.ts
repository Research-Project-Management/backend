import { Injectable, Optional } from '@nestjs/common';
import { AttachmentsService } from './core/services/attachments.service';
import {
  PdfProvider,
  ExtractedPdfDocument,
} from './core/adapters/pdf.provider';
import { WebSnapshotService } from './core/adapters/web-snapshot.service';
import { AnnotationsService } from './core/services/annotations.service';

export const EXTRACTION_FACADE = 'EXTRACTION_FACADE';

export interface IExtractionFacade {
  getItemAttachments(userId: string, itemId: string): Promise<any>;
  getItemAttachment(
    userId: string,
    attachmentId: string,
    itemId?: string,
    projectId?: string,
  ): Promise<any>;
  createAttachment(data: any, projectId?: string): Promise<any>;
  extractDocumentFromBuffer(
    buffer: Buffer,
    options?: any,
  ): Promise<ExtractedPdfDocument>;
  extractMetadataFromBuffer(buffer: Buffer): any;
  captureWebSnapshot(url: string, itemId: string, userId: string): Promise<any>;
  reassignContentToItem(
    duplicateItemIds: string[],
    primaryItemId: string,
    tx?: any,
  ): Promise<void>;
  // Annotation delegation methods
  getAnnotationsByAttachment(
    userId: string,
    attachmentId: string,
  ): Promise<any[]>;
  getAnnotationsByAttachmentFull(
    userId: string,
    attachmentId: string,
    pageIndex?: number,
    type?: any,
  ): Promise<any[]>;
  getAnnotation(
    userId: string,
    annotationId: string,
    projectId?: string,
  ): Promise<any | null>;
  createAnnotation(userId: string, data: any): Promise<any>;
  updateAnnotation(
    userId: string,
    annotationId: string,
    expectedVersion: number,
    data: any,
  ): Promise<any>;
  deleteAnnotation(
    userId: string,
    annotationId: string,
    expectedVersion?: number,
  ): Promise<boolean>;
  batchUpsertAnnotations(
    userId: string,
    attachmentId: string,
    data: any,
  ): Promise<any>;
  listAnnotations(userId: string, filters?: any): Promise<any[]>;
}

@Injectable()
export class ExtractionFacade implements IExtractionFacade {
  constructor(
    @Optional() private readonly attachmentsService?: AttachmentsService,
    @Optional() private readonly pdfProvider?: PdfProvider,
    @Optional() private readonly webSnapshotService?: WebSnapshotService,
    @Optional() private readonly annotationsService?: AnnotationsService,
  ) {}

  async getItemAttachments(userId: string, itemId: string): Promise<any> {
    if (!this.attachmentsService) return { attachments: [], total: 0 };
    return this.attachmentsService.getItemAttachments(userId, itemId);
  }

  async getItemAttachment(
    userId: string,
    attachmentId: string,
    itemId?: string,
    projectId?: string,
  ): Promise<any> {
    if (!this.attachmentsService) return null;
    return this.attachmentsService.getItemAttachment(
      userId,
      itemId,
      attachmentId,
      projectId,
    );
  }

  async createAttachment(data: any, projectId?: string): Promise<any> {
    if (!this.attachmentsService) return null;
    return this.attachmentsService.createAttachment(data, projectId);
  }

  async extractDocumentFromBuffer(
    buffer: Buffer,
    options?: any,
  ): Promise<ExtractedPdfDocument> {
    if (!this.pdfProvider) {
      throw new Error('PdfProvider is not initialized in ExtractionFacade');
    }
    return this.pdfProvider.extractDocumentFromBuffer(buffer, options);
  }

  extractMetadataFromBuffer(buffer: Buffer): any {
    if (!this.pdfProvider) return {};
    return this.pdfProvider.extractMetadataFromBuffer(buffer);
  }

  async captureWebSnapshot(
    url: string,
    itemId: string,
    userId: string,
  ): Promise<any> {
    if (!this.webSnapshotService) {
      throw new Error(
        'WebSnapshotService is not initialized in ExtractionFacade',
      );
    }
    return this.webSnapshotService.captureAndAttach(url, itemId, userId);
  }

  async reassignContentToItem(
    duplicateItemIds: string[],
    primaryItemId: string,
    tx?: any,
  ): Promise<void> {
    if (this.attachmentsService) {
      await this.attachmentsService.reassignToItem(
        duplicateItemIds,
        primaryItemId,
        tx,
      );
    }
  }

  // ─── Annotation delegation methods ─────────────────────────────────────────

  async getAnnotationsByAttachment(
    userId: string,
    attachmentId: string,
  ): Promise<any[]> {
    if (!this.annotationsService) return [];
    return this.annotationsService.getAnnotationsByAttachment(
      userId,
      attachmentId,
    );
  }

  async getAnnotationsByAttachmentFull(
    userId: string,
    attachmentId: string,
    pageIndex?: number,
    type?: any,
  ): Promise<any[]> {
    if (!this.annotationsService) return [];
    return this.annotationsService.getAnnotationsByAttachment(
      userId,
      attachmentId,
      pageIndex,
      type,
    );
  }

  async getAnnotation(
    userId: string,
    annotationId: string,
    _projectId?: string,
  ): Promise<any | null> {
    if (!this.annotationsService) return null;
    return this.annotationsService.getAnnotation(userId, annotationId);
  }

  async createAnnotation(userId: string, data: any): Promise<any> {
    if (!this.annotationsService) return null;
    return this.annotationsService.createAnnotation(userId, data);
  }

  async updateAnnotation(
    userId: string,
    annotationId: string,
    expectedVersion: number,
    data: any,
  ): Promise<any> {
    if (!this.annotationsService) return null;
    return this.annotationsService.updateAnnotation(
      userId,
      annotationId,
      expectedVersion,
      data,
    );
  }

  async deleteAnnotation(
    userId: string,
    annotationId: string,
    expectedVersion?: number,
  ): Promise<boolean> {
    if (!this.annotationsService) return false;
    return this.annotationsService.deleteAnnotation(
      userId,
      annotationId,
      expectedVersion,
    );
  }

  async batchUpsertAnnotations(
    userId: string,
    attachmentId: string,
    data: any,
  ): Promise<any> {
    if (!this.annotationsService) {
      return { created: [], updated: [], deleted: [] };
    }
    return this.annotationsService.batchUpsertAnnotations(
      userId,
      attachmentId,
      data,
    );
  }

  async listAnnotations(userId: string, filters?: any): Promise<any[]> {
    if (!this.annotationsService) return [];
    if (filters?.attachmentId) {
      return this.annotationsService.getAnnotationsByAttachment(
        userId,
        filters.attachmentId,
        filters.pageIndex,
        filters.type,
      );
    }
    return [];
  }
}
