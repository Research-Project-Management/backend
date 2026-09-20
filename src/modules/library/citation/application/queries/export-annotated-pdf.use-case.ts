import { Injectable, Logger } from '@nestjs/common';
import { ExportsService } from '../services/exports.service';

export interface ExportAnnotatedPdfQuery {
  userId: string;
  itemId: string;
  options?: any;
  projectId?: string;
}

export interface ExportAnnotatedPdfResult {
  filename: string;
  mimeType: string;
  base64: string;
}

/**
 * Query Use Case — Export Annotated PDF
 *
 * Clean Architecture & CQRS:
 * Bakes highlighted annotations and comments into the source PDF file and exports base64.
 */
@Injectable()
export class ExportAnnotatedPdfUseCase {
  private readonly logger = new Logger(ExportAnnotatedPdfUseCase.name);

  constructor(private readonly exportsService: ExportsService) {}

  async execute(
    query: ExportAnnotatedPdfQuery,
  ): Promise<ExportAnnotatedPdfResult> {
    this.logger.debug(
      `Executing ExportAnnotatedPdfUseCase for item ${query.itemId} (user: ${query.userId})`,
    );
    const res = await this.exportsService.exportAnnotatedItemPdf(
      query.userId,
      query.itemId,
      query.options,
      query.projectId,
    );
    return {
      filename: res.filename,
      mimeType: 'application/pdf',
      base64: Buffer.from(res.buffer).toString('base64'),
    };
  }
}
