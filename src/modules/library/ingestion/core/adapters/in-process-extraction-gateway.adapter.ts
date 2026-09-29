import { Injectable, Inject, Optional } from '@nestjs/common';
import {
  EXTRACTION_GATEWAY_PORT,
  IExtractionGatewayPort,
} from '../ports/extraction-gateway.port';
import {
  CONTENT_FACADE,
  IContentFacade,
  READER_FACADE,
  IReaderFacade,
} from '../../../extraction/extraction.facade';

/**
 * In-process adapter connecting Ingestion to Extraction/Reader via ContentFacade.
 * When separating into independent microservices, this adapter is replaced by HttpExtractionGatewayAdapter.
 */
@Injectable()
export class InProcessExtractionGatewayAdapter implements IExtractionGatewayPort {
  constructor(
    @Optional()
    @Inject(CONTENT_FACADE)
    private readonly contentFacade?: IContentFacade,
    @Optional()
    @Inject(READER_FACADE)
    private readonly readerFacade?: IReaderFacade,
  ) {}

  extractDocumentFromBuffer(buffer: Buffer, options?: any) {
    if (this.contentFacade?.extractDocumentFromBuffer) {
      return this.contentFacade.extractDocumentFromBuffer(buffer, options);
    }
    return Promise.resolve(null);
  }

  extractMetadataFromBuffer(buffer: Buffer) {
    if (this.contentFacade?.extractMetadataFromBuffer) {
      return Promise.resolve(
        this.contentFacade.extractMetadataFromBuffer(buffer),
      );
    }
    return Promise.resolve(null);
  }

  captureWebSnapshot(url: string, itemId: string, userId: string) {
    if (this.contentFacade?.captureWebSnapshot) {
      return this.contentFacade.captureWebSnapshot(url, itemId, userId);
    }
    return Promise.resolve(null);
  }

  createAttachment(data: any, projectId?: string) {
    if (this.contentFacade?.createAttachment) {
      return this.contentFacade.createAttachment(data, projectId);
    }
    return Promise.resolve(null);
  }

  createNote(userId: string, data: any) {
    if (this.contentFacade?.createNote) {
      return this.contentFacade.createNote(userId, data);
    }
    return Promise.resolve(null);
  }

  reassignContentToItem(
    duplicateItemIds: string[],
    primaryItemId: string,
    tx?: any,
  ) {
    if (this.readerFacade?.reassignContentToItem) {
      return this.readerFacade.reassignContentToItem(
        duplicateItemIds,
        primaryItemId,
        tx,
      );
    }
    return Promise.resolve();
  }
}
