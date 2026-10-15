export const EXTRACTION_FACADE = 'EXTRACTION_FACADE';

export interface IExtractionFacade {
  getItemAttachments?<T = unknown>(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<T[]>;
  getItemAttachment?<T = unknown>(
    userId: string,
    attachmentId: string,
    itemId?: string,
    projectId?: string,
  ): Promise<T | null>;
  createAttachment?<T = unknown, D = Record<string, unknown>>(
    data: D,
    projectId?: string,
  ): Promise<T>;
  extractDocumentFromBuffer?<T = unknown>(
    buffer: Buffer,
    options?: Record<string, unknown>,
  ): Promise<T>;
  extractMetadataFromBuffer?(buffer: Buffer): Record<string, unknown>;
  extractTrustedMetadata?<T = unknown>(
    buffer: Buffer,
    preferredFilename?: string,
  ): Promise<T>;
  captureWebSnapshot?<T = unknown>(
    url: string,
    itemId: string,
    userId: string,
  ): Promise<T>;
  reassignContentToItem?(
    duplicateItemIds: string[],
    primaryItemId: string,
    tx?: unknown,
  ): Promise<void>;
  getAnnotationsByAttachment?<T = unknown>(
    userId: string,
    attachmentId: string,
    options?: Record<string, unknown>,
  ): Promise<T[]>;
  createAnnotation?<T = unknown, D = Record<string, unknown>>(
    userId: string,
    data: D,
  ): Promise<T>;
  updateAnnotation?<T = unknown, D = Record<string, unknown>>(
    userId: string,
    id: string,
    data: D,
  ): Promise<T>;
  deleteAnnotation?(userId: string, id: string): Promise<void>;
  batchAnnotations?<T = unknown, D = Record<string, unknown>>(
    userId: string,
    data: D,
  ): Promise<T>;
  [key: string]: unknown;
}
