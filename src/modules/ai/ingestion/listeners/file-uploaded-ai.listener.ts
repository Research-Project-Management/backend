import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { FileUploadedEvent } from '@/modules/storage/domain/events/file-uploaded.event';
import { DocumentAiIngestionService } from '../services/document-ai-ingestion.service';
import * as path from 'path';

const INGESTIBLE_MIME_TYPES = new Set([
  'application/pdf',
  'text/plain',
  'text/markdown',
  'application/x-markdown',
]);

const INGESTIBLE_EXTENSIONS = new Set(['.pdf', '.md', '.markdown', '.txt']);

@Injectable()
export class FileUploadedAiListener {
  private readonly logger = new Logger(FileUploadedAiListener.name);

  constructor(private readonly ingestionService: DocumentAiIngestionService) {}

  /**
   * Listens asynchronously to 'file.uploaded' events dispatched by Storage.
   * Filters for academic papers and documents, initiating automated RAG vector ingestion.
   */
  @OnEvent('file.uploaded', { async: true })
  async handleFileUploaded(event: FileUploadedEvent): Promise<void> {
    const ext = path.extname(event.filename || '').toLowerCase();
    const mime = (event.mimeType || '').toLowerCase();

    const isIngestible =
      INGESTIBLE_MIME_TYPES.has(mime) || INGESTIBLE_EXTENSIONS.has(ext);

    if (!isIngestible) {
      this.logger.debug(
        `File ${event.fileId} (${event.filename}, mime: ${event.mimeType}) is not a textual/scientific document. Skipping AI vector ingestion.`,
      );
      return;
    }

    this.logger.log(
      `Received 'file.uploaded' event for scientific document ${event.filename} (${event.fileId}). Dispatching to AI ingestion pipeline.`,
    );

    try {
      await this.ingestionService.ingestFile(event);
    } catch (err: any) {
      this.logger.error(
        `Uncaught error during automated AI ingestion for file ${event.fileId}: ${err.message}`,
        err.stack,
      );
    }
  }
}
