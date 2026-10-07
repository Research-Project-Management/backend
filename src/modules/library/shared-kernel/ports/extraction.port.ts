export const EXTRACTION_FACADE = 'EXTRACTION_FACADE';

export interface IExtractionFacade {
  getItemAttachments?(userId: string, itemId: string): Promise<any[]>;
  getItemAttachment?(
    userId: string,
    attachmentId: string,
    itemId?: string,
    projectId?: string,
  ): Promise<any | null>;
  createAttachment?(data: any, projectId?: string): Promise<any>;
  extractDocumentFromBuffer?(
    buffer: Buffer,
    options?: Record<string, any>,
  ): Promise<any>;
  extractMetadataFromBuffer?(buffer: Buffer): Record<string, any>;
  extractTrustedMetadata?(
    buffer: Buffer,
    preferredFilename?: string,
  ): Promise<any>;
  captureWebSnapshot?(
    url: string,
    itemId: string,
    userId: string,
  ): Promise<any>;
  reassignContentToItem?(
    duplicateItemIds: string[],
    primaryItemId: string,
    tx?: any,
  ): Promise<void>;
  getAnnotationsByAttachment?(
    userId: string,
    attachmentId: string,
    options?: any,
  ): Promise<any[]>;
  createAnnotation?(userId: string, data: any): Promise<any>;
  updateAnnotation?(userId: string, id: string, data: any): Promise<any>;
  deleteAnnotation?(userId: string, id: string): Promise<void>;
  batchAnnotations?(userId: string, data: any): Promise<any>;
  [key: string]: any;
}
