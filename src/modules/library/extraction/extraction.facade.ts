import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AttachmentsService } from './services/attachments.service';
import {
  PdfProvider,
  ExtractedPdfDocument,
  ExtractedPdfMetadata,
} from './providers/pdf.provider';
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
import {
  EXTRACTION_FACADE,
  IExtractionFacade,
} from '@/modules/library/core/ports/extraction.port';
export { EXTRACTION_FACADE };
export type { IExtractionFacade };

@Injectable()
export class ExtractionFacade {
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
    projectId?: string,
  ): Promise<AttachmentEntity[]> {
    const res = await this.attachmentsService.getItemAttachments(
      userId,
      itemId,
      projectId,
    );
    return res.attachments || [];
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
    return res?.attachment || null;
  }

  async createAttachment(
    data: CreateAttachmentInput,
    projectId?: string,
  ): Promise<AttachmentEntity> {
    return await this.attachmentsService.createAttachment(data, projectId);
  }

  async extractDocumentFromBuffer(
    buffer: Buffer,
    options?: { maxPages?: number; headerOnly?: boolean },
  ): Promise<ExtractedPdfDocument> {
    return this.pdfProvider.extractDocumentFromBuffer(buffer, options);
  }

  extractMetadataFromBuffer(buffer: Buffer): ExtractedPdfMetadata {
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
    return res.attachment;
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

  // Annotation delegation methods

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
