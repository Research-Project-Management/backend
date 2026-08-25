import { Injectable } from '@nestjs/common';
import { PdfExtractorService } from './pdf-extractor.service';

@Injectable()
export class AttachmentsService {
  constructor(private readonly pdfExtractorService: PdfExtractorService) {}

  /**
   * Extract metadata identifiers from a PDF file URL
   */
  async extractFromPdf(fileUrl: string) {
    return this.pdfExtractorService.extractMetadataFromUrl(fileUrl);
  }
}
