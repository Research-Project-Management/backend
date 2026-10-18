import { Prisma } from '@prisma/client';
import {
  ExtractedPdfDocument,
  ExtractedPdfMetadata,
} from '@/modules/library/extraction/providers/pdf.provider';
import { TrustedExtractionResult } from '@/modules/library/extraction/types/trusted-extraction.types';
import {
  AttachmentEntity,
  CreateAttachmentInput,
} from '@/modules/library/extraction/types/attachments.types';
import {
  AnnotationEntity,
  CreateAnnotationData,
  UpdateAnnotationData,
  BatchAnnotationsData,
  BatchAnnotationsResult,
  AnnotationType,
} from '@/modules/library/extraction/types/annotations.types';

export const EXTRACTION_FACADE = 'EXTRACTION_FACADE';

export interface IExtractionFacade {
  getItemAttachments(
    userId: string,
    itemId: string,
    projectId?: string,
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
  extractDocumentFromBuffer<T = ExtractedPdfDocument>(
    buffer: Buffer,
    options?: { maxPages?: number; headerOnly?: boolean },
  ): Promise<T>;
  extractMetadataFromBuffer<T = ExtractedPdfMetadata>(buffer: Buffer): T;
  extractTrustedMetadata<T = TrustedExtractionResult>(
    buffer: Buffer,
    preferredFilename?: string,
  ): Promise<T>;
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
