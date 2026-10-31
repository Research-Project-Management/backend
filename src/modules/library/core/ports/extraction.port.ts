import type { Prisma } from '@prisma/client';
import type {
  ExtractedPdfDocument,
  ExtractedPdfMetadata,
  TrustedExtractionResult,
  AttachmentEntity,
  CreateAttachmentInput,
  AnnotationEntity,
  CreateAnnotationData,
  UpdateAnnotationData,
  BatchAnnotationsData,
  BatchAnnotationsResult,
  AnnotationType,
} from '../types/extraction.types';

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
  extractDocumentFromBuffer(
    buffer: Buffer,
    options?: {
      maxPages?: number;
      headerOnly?: boolean;
      skipTrustedExtraction?: boolean;
    },
  ): Promise<ExtractedPdfDocument>;
  extractMetadataFromBuffer(buffer: Buffer): ExtractedPdfMetadata;
  extractTrustedMetadata(
    buffer: Buffer,
    preferredFilename?: string,
  ): Promise<TrustedExtractionResult>;
  captureWebSnapshot(
    url: string,
    itemId: string,
    userId: string,
    projectId?: string,
  ): Promise<AttachmentEntity>;
  reassignContentToItem(
    duplicateItemIds: string[],
    primaryItemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<string[]>;
  cleanupOrphanedFiles?(fileIds: string[]): Promise<void>;
  getAnnotationsByAttachment(
    userId: string,
    attachmentId: string,
    pageIndex?: number,
    type?: AnnotationType,
    projectId?: string,
  ): Promise<AnnotationEntity[]>;
  getAnnotation(
    userId: string,
    annotationId: string,
    projectId?: string,
  ): Promise<AnnotationEntity | null>;
  createAnnotation(
    userId: string,
    data: CreateAnnotationData,
    projectId?: string,
  ): Promise<AnnotationEntity>;
  updateAnnotation(
    userId: string,
    annotationId: string,
    expectedVersion: number,
    data: UpdateAnnotationData,
    projectId?: string,
  ): Promise<AnnotationEntity>;
  deleteAnnotation(
    userId: string,
    annotationId: string,
    expectedVersion?: number,
    projectId?: string,
  ): Promise<boolean>;
  batchUpsertAnnotations(
    userId: string,
    attachmentId: string,
    data: BatchAnnotationsData,
    projectId?: string,
  ): Promise<BatchAnnotationsResult>;
}
