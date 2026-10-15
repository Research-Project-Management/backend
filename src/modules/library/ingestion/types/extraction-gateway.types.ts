export const EXTRACTION_GATEWAY_PORT = Symbol('EXTRACTION_GATEWAY_PORT');

export interface IExtractionGatewayPort {
  extractTrustedMetadata<T = unknown>(
    buffer: Buffer,
    preferredFilename?: string,
  ): Promise<T | null>;
  extractDocumentFromBuffer<T = unknown>(
    buffer: Buffer,
    options?: Record<string, unknown>,
  ): Promise<T | null>;
  extractMetadataFromBuffer<T = unknown>(buffer: Buffer): Promise<T | null>;
  captureWebSnapshot<T = unknown>(
    url: string,
    itemId: string,
    userId: string,
  ): Promise<T | null>;
  createAttachment<T = unknown, D = Record<string, unknown>>(
    data: D,
    projectId?: string,
  ): Promise<T | null>;
  reassignContentToItem(
    duplicateItemIds: string[],
    primaryItemId: string,
    tx?: unknown,
  ): Promise<void>;
}
