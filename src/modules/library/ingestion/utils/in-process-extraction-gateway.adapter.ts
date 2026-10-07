import { Injectable, Inject, Optional } from '@nestjs/common';
import {
  EXTRACTION_GATEWAY_PORT,
  IExtractionGatewayPort,
} from '../types/extraction-gateway.types';
import {
  EXTRACTION_FACADE,
  IExtractionFacade,
} from '../../extraction/extraction.facade';

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

  extractDocumentFromBuffer(buffer: Buffer, options?: any) {
    if (!this.extractionFacade) return Promise.resolve(null);
    return this.extractionFacade.extractDocumentFromBuffer(buffer, options);
  }

  extractMetadataFromBuffer(buffer: Buffer) {
    if (!this.extractionFacade) return Promise.resolve(null);
    return Promise.resolve(
      this.extractionFacade.extractMetadataFromBuffer(buffer),
    );
  }

  captureWebSnapshot(url: string, itemId: string, userId: string) {
    if (!this.extractionFacade) return Promise.resolve(null);
    return this.extractionFacade.captureWebSnapshot(url, itemId, userId);
  }

  createAttachment(data: any, projectId?: string) {
    if (!this.extractionFacade) return Promise.resolve(null);
    return this.extractionFacade.createAttachment(data, projectId);
  }

  reassignContentToItem(
    duplicateItemIds: string[],
    primaryItemId: string,
    tx?: any,
  ) {
    if (!this.extractionFacade) return Promise.resolve();
    return this.extractionFacade.reassignContentToItem(
      duplicateItemIds,
      primaryItemId,
      tx,
    );
  }
}
