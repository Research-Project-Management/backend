import { Injectable } from '@nestjs/common';
import { AttachmentsService } from './services/attachments.service';
import { PdfProvider, ExtractedPdfDocument } from './utils/pdf.provider';
import { WebSnapshotService } from './services/web-snapshot.service';
import { AnnotationsService } from './services/annotations.service';
import { TrustedExtractionService } from './services/trusted-extraction.service';
import { TrustedExtractionResult } from './types/trusted-extraction.types';

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
  extractTrustedMetadata(
    buffer: Buffer,
    preferredFilename?: string,
  ): Promise<TrustedExtractionResult>;
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
    private readonly attachmentsService: AttachmentsService,
    private readonly pdfProvider: PdfProvider,
    private readonly webSnapshotService: WebSnapshotService,
    private readonly annotationsService: AnnotationsService,
    private readonly trustedExtractor: TrustedExtractionService,
  ) {}

  async getItemAttachments(userId: string, itemId: string): Promise<any> {
    return this.attachmentsService.getItemAttachments(userId, itemId);
  }

  async getItemAttachment(
    userId: string,
    attachmentId: string,
    itemId?: string,
    projectId?: string,
  ): Promise<any> {
    return this.attachmentsService.getItemAttachment(
      userId,
      itemId,
      attachmentId,
      projectId,
    );
  }

  async createAttachment(data: any, projectId?: string): Promise<any> {
    return this.attachmentsService.createAttachment(data, projectId);
  }

  async extractDocumentFromBuffer(
    buffer: Buffer,
    options?: any,
  ): Promise<ExtractedPdfDocument> {
    return this.pdfProvider.extractDocumentFromBuffer(buffer, options);
  }

  extractMetadataFromBuffer(buffer: Buffer): any {
    return this.pdfProvider.extractMetadataFromBuffer(buffer);
  }

  async extractTrustedMetadata(
    buffer: Buffer,
    preferredFilename?: string,
  ): Promise<TrustedExtractionResult> {
    return this.trustedExtractor.extract(buffer, preferredFilename);
  }

  async captureWebSnapshot(
    url: string,
    itemId: string,
    userId: string,
  ): Promise<any> {
    return this.webSnapshotService.captureAndAttach(url, itemId, userId);
  }

  async reassignContentToItem(
    duplicateItemIds: string[],
    primaryItemId: string,
    tx?: any,
  ): Promise<void> {
    await this.attachmentsService.reassignToItem(
      duplicateItemIds,
      primaryItemId,
      tx,
    );
  }

  // ─── Annotation delegation methods ─────────────────────────────────────────

  async getAnnotationsByAttachment(
    userId: string,
    attachmentId: string,
  ): Promise<any[]> {
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
    return this.annotationsService.getAnnotation(userId, annotationId);
  }

  async createAnnotation(userId: string, data: any): Promise<any> {
    return this.annotationsService.createAnnotation(userId, data);
  }

  async updateAnnotation(
    userId: string,
    annotationId: string,
    expectedVersion: number,
    data: any,
  ): Promise<any> {
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
    return this.annotationsService.batchUpsertAnnotations(
      userId,
      attachmentId,
      data,
    );
  }

  async listAnnotations(userId: string, filters?: any): Promise<any[]> {
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
