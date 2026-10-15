import { Injectable, Inject, Optional } from '@nestjs/common';
import { IExtractionGatewayPort } from '@/modules/library/ingestion/types/extraction-gateway.types';
import {
  EXTRACTION_FACADE,
  IExtractionFacade,
} from '@/modules/library/shared-kernel';

/**
 * In-process adapter connecting Ingestion to Extraction via ExtractionFacade.
 * When separating into independent microservices, this adapter is replaced by HttpExtractionGatewayAdapter.
 */
@Injectable()
export class InProcessExtractionGatewayAdapter implements IExtractionGatewayPort {
  constructor(
    @Optional()
    @Inject(EXTRACTION_FACADE)
    private readonly extractionFacade?: IExtractionFacade,
  ) {}

  extractTrustedMetadata<T = unknown>(
    buffer: Buffer,
    preferredFilename?: string,
  ): Promise<T | null> {
    if (!this.extractionFacade?.extractTrustedMetadata)
      return Promise.resolve(null);
    return this.extractionFacade.extractTrustedMetadata<T>(
      buffer,
      preferredFilename,
    );
  }

  extractDocumentFromBuffer<T = unknown>(
    buffer: Buffer,
    options?: Record<string, unknown>,
  ): Promise<T | null> {
    if (!this.extractionFacade?.extractDocumentFromBuffer)
      return Promise.resolve(null);
    return this.extractionFacade.extractDocumentFromBuffer<T>(buffer, options);
  }

  extractMetadataFromBuffer<T = unknown>(buffer: Buffer): Promise<T | null> {
    if (!this.extractionFacade?.extractMetadataFromBuffer)
      return Promise.resolve(null);
    return Promise.resolve(
      this.extractionFacade.extractMetadataFromBuffer(buffer) as T,
    );
  }

  captureWebSnapshot<T = unknown>(
    url: string,
    itemId: string,
    userId: string,
  ): Promise<T | null> {
    if (!this.extractionFacade?.captureWebSnapshot)
      return Promise.resolve(null);
    return this.extractionFacade.captureWebSnapshot<T>(url, itemId, userId);
  }

  createAttachment<T = unknown, D = Record<string, unknown>>(
    data: D,
    projectId?: string,
  ): Promise<T | null> {
    if (!this.extractionFacade?.createAttachment) return Promise.resolve(null);
    return this.extractionFacade.createAttachment<T, D>(data, projectId);
  }

  reassignContentToItem(
    duplicateItemIds: string[],
    primaryItemId: string,
    tx?: unknown,
  ): Promise<void> {
    if (!this.extractionFacade?.reassignContentToItem) return Promise.resolve();
    return this.extractionFacade.reassignContentToItem(
      duplicateItemIds,
      primaryItemId,
      tx,
    );
  }
}
