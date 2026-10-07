import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AttachmentsService } from './services/attachments.service';
import { PdfProvider, ExtractedPdfDocument } from './utils/pdf.provider';
import { WebSnapshotService } from './services/web-snapshot.service';
import { AnnotationsService } from './services/annotations.service';
import { TrustedExtractionService } from './services/trusted-extraction.service';
import { TrustedExtractionResult } from './types/trusted-extraction.types';
import {
  AttachmentEntity,
  CreateAttachmentInput,
} from './types/attachments.types';
import {
  AnnotationEntity,
  CreateAnnotationData,
  UpdateAnnotationData,
  BatchAnnotationsData,
  BatchAnnotationsResult,
  AnnotationType,
} from './types/annotations.types';

export const EXTRACTION_FACADE = 'EXTRACTION_FACADE';

export interface IExtractionFacade {
  getItemAttachments(
    userId: string,
    itemId: string,
  ): Promise<AttachmentEntity[]>;
  getItemAttachment(
    userId: string,
    attachmentId: string,
    itemId?: string,
    projectId?: string,
  ): Promise<AttachmentEntity | null>;
  createAttachment(
    data: CreateAttachmentInput,
    projectId?: string,
  ): Promise<AttachmentEntity>;
  extractDocumentFromBuffer(
    buffer: Buffer,
    options?: Record<string, any>,
  ): Promise<ExtractedPdfDocument>;
  extractMetadataFromBuffer(buffer: Buffer): Record<string, any>;
  extractTrustedMetadata(
    buffer: Buffer,
    preferredFilename?: string,
  ): Promise<TrustedExtractionResult>;
  captureWebSnapshot(
    url: string,
    itemId: string,
    userId: string,
  ): Promise<AttachmentEntity>;
  reassignContentToItem(
    duplicateItemIds: string[],
    primaryItemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void>;
  // Annotation delegation methods
  getAnnotationsByAttachment(
    userId: string,
    attachmentId: string,
  ): Promise<AnnotationEntity[]>;
  getAnnotationsByAttachmentFull(
    userId: string,
    attachmentId: string,
    pageIndex?: number,
    type?: AnnotationType,
  ): Promise<AnnotationEntity[]>;
  getAnnotation(
    userId: string,
    annotationId: string,
    projectId?: string,
  ): Promise<AnnotationEntity | null>;
  createAnnotation(
    userId: string,
    data: CreateAnnotationData,
  ): Promise<AnnotationEntity>;
  updateAnnotation(
    userId: string,
    annotationId: string,
    expectedVersion: number,
    data: UpdateAnnotationData,
  ): Promise<AnnotationEntity>;
  deleteAnnotation(
    userId: string,
    annotationId: string,
    expectedVersion?: number,
  ): Promise<boolean>;
  batchUpsertAnnotations(
    userId: string,
    attachmentId: string,
    data: BatchAnnotationsData,
  ): Promise<BatchAnnotationsResult>;
  listAnnotations(
    userId: string,
    filters?: {
      attachmentId?: string;
      pageIndex?: number;
      type?: AnnotationType;
    },
  ): Promise<AnnotationEntity[]>;
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

  async getItemAttachments(
    userId: string,
    itemId: string,
  ): Promise<AttachmentEntity[]> {
    const res = await this.attachmentsService.getItemAttachments(
      userId,
      itemId,
    );
    return (res.attachments || []) as unknown as AttachmentEntity[];
  }

  async getItemAttachment(
    userId: string,
    attachmentId: string,
    itemId?: string,
    projectId?: string,
  ): Promise<AttachmentEntity | null> {
    const res = await this.attachmentsService.getItemAttachment(
      userId,
      itemId,
      attachmentId,
      projectId,
    );
    return (res?.attachment || null) as unknown as AttachmentEntity | null;
  }

  async createAttachment(
    data: CreateAttachmentInput,
    projectId?: string,
  ): Promise<AttachmentEntity> {
    return this.attachmentsService.createAttachment(data, projectId);
  }

  async extractDocumentFromBuffer(
    buffer: Buffer,
    options?: Record<string, any>,
  ): Promise<ExtractedPdfDocument> {
    return this.pdfProvider.extractDocumentFromBuffer(buffer, options);
  }

  extractMetadataFromBuffer(buffer: Buffer): Record<string, any> {
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
  ): Promise<AttachmentEntity> {
    const res = await this.webSnapshotService.captureAndAttach(
      url,
      itemId,
      userId,
    );
    return res.attachment as unknown as AttachmentEntity;
  }

  async reassignContentToItem(
    duplicateItemIds: string[],
    primaryItemId: string,
    tx?: Prisma.TransactionClient,
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
  ): Promise<AnnotationEntity[]> {
    return this.annotationsService.getAnnotationsByAttachment(
      userId,
      attachmentId,
    );
  }

  async getAnnotationsByAttachmentFull(
    userId: string,
    attachmentId: string,
    pageIndex?: number,
    type?: AnnotationType,
  ): Promise<AnnotationEntity[]> {
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
  ): Promise<AnnotationEntity | null> {
    return this.annotationsService.getAnnotation(userId, annotationId);
  }

  async createAnnotation(
    userId: string,
    data: CreateAnnotationData,
  ): Promise<AnnotationEntity> {
    return this.annotationsService.createAnnotation(userId, data);
  }

  async updateAnnotation(
    userId: string,
    annotationId: string,
    expectedVersion: number,
    data: UpdateAnnotationData,
  ): Promise<AnnotationEntity> {
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
    data: BatchAnnotationsData,
  ): Promise<BatchAnnotationsResult> {
    return this.annotationsService.batchUpsertAnnotations(
      userId,
      attachmentId,
      data,
    );
  }

  async listAnnotations(
    userId: string,
    filters?: {
      attachmentId?: string;
      pageIndex?: number;
      type?: AnnotationType;
    },
  ): Promise<AnnotationEntity[]> {
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
