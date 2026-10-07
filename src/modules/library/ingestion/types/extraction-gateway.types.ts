export const EXTRACTION_GATEWAY_PORT = Symbol('EXTRACTION_GATEWAY_PORT');

export interface IExtractionGatewayPort {
  extractDocumentFromBuffer?(buffer: Buffer, options?: any): Promise<any>;
  extractMetadataFromBuffer?(buffer: Buffer): Promise<any>;
  captureWebSnapshot?(
    url: string,
    itemId: string,
    userId: string,
  ): Promise<any>;
  createAttachment?(data: any, projectId?: string): Promise<any>;
  reassignContentToItem?(
    duplicateItemIds: string[],
    primaryItemId: string,
    tx?: any,
  ): Promise<void>;
}
