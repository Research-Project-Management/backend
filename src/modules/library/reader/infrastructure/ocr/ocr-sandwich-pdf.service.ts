import { Injectable, Logger } from '@nestjs/common';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { OcrPageResult } from './ocr.types';

@Injectable()
export class OcrSandwichPdfService {
  private readonly logger = new Logger(OcrSandwichPdfService.name);

  /**
   * Embeds an invisible searchable text layer into a PDF document based on OCR bounding boxes.
   * This turns an image-only scanned PDF into a searchable "Sandwich PDF" that can be
   * parsed by GROBID (extracting headers, sections, figures, tables, formulas, citations)
   * and indexed by standard PDF full-text tools.
   */
  async generateSearchablePdf(
    originalPdfBuffer: Buffer,
    pageResults: OcrPageResult[],
    imageDimensionsMap?: Map<number, { width: number; height: number }>,
  ): Promise<Buffer> {
    const ocrPages = pageResults.filter(
      (p) => p.wasOcr && (p.words.length > 0 || p.blocks.length > 0),
    );
    if (ocrPages.length === 0) {
      return originalPdfBuffer;
    }

    try {
      const startTime = Date.now();
      const pdfDoc = await PDFDocument.load(originalPdfBuffer, {
        ignoreEncryption: true,
      });
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const totalDocPages = pdfDoc.getPageCount();

      for (const pageResult of ocrPages) {
        if (pageResult.pageIndex < 0 || pageResult.pageIndex >= totalDocPages) {
          continue;
        }

        const pdfPage = pdfDoc.getPage(pageResult.pageIndex);
        const pdfWidth = pdfPage.getWidth();
        const pdfHeight = pdfPage.getHeight();

        const imgDim =
          pageResult.imageWidth && pageResult.imageHeight
            ? { width: pageResult.imageWidth, height: pageResult.imageHeight }
            : imageDimensionsMap?.get(pageResult.pageIndex) || {
                width: pdfWidth * 2,
                height: pdfHeight * 2,
              };

        const scaleX = pdfWidth / Math.max(1, imgDim.width);
        const scaleY = pdfHeight / Math.max(1, imgDim.height);

        // Prefer word-level positioning if available
        if (pageResult.words && pageResult.words.length > 0) {
          for (const word of pageResult.words) {
            const sanitized = this.sanitizeForPdf(word.text);
            if (!sanitized) continue;

            const boxWidth = Math.max(
              1,
              (word.bbox.x1 - word.bbox.x0) * scaleX,
            );
            const boxHeight = Math.max(
              1,
              (word.bbox.y1 - word.bbox.y0) * scaleY,
            );
            const pdfX = Math.max(0, word.bbox.x0 * scaleX);
            // Invert Y coordinate (PDF origin is bottom-left, image is top-left)
            const pdfY = Math.max(0, pdfHeight - word.bbox.y1 * scaleY);
            const fontSize = Math.max(2, Math.min(boxHeight * 0.85, 36));

            try {
              pdfPage.drawText(sanitized, {
                x: pdfX,
                y: pdfY,
                size: fontSize,
                font,
                opacity: 0, // Invisible text layer over the scan
              });
            } catch {
              // Ignore word drawing error
            }
          }
        } else {
          // Fallback to block/line level drawing
          for (const block of pageResult.blocks) {
            for (const line of block.lines) {
              const sanitized = this.sanitizeForPdf(line.text);
              if (!sanitized) continue;

              const boxHeight = Math.max(
                1,
                (line.bbox.y1 - line.bbox.y0) * scaleY,
              );
              const pdfX = Math.max(0, line.bbox.x0 * scaleX);
              const pdfY = Math.max(0, pdfHeight - line.bbox.y1 * scaleY);
              const fontSize = Math.max(2, Math.min(boxHeight * 0.85, 36));

              try {
                pdfPage.drawText(sanitized, {
                  x: pdfX,
                  y: pdfY,
                  size: fontSize,
                  font,
                  opacity: 0,
                });
              } catch {
                // Ignore line drawing error
              }
            }
          }
        }
      }

      const pdfBytes = await pdfDoc.save();
      const resultBuffer = Buffer.from(pdfBytes);
      this.logger.log(
        `Generated Searchable Sandwich PDF for ${ocrPages.length} scanned pages in ${Date.now() - startTime}ms (size: ${(resultBuffer.length / 1024).toFixed(1)} KB)`,
      );
      return resultBuffer;
    } catch (error: any) {
      this.logger.warn(
        `Failed to generate searchable Sandwich PDF: ${error?.message || error}. Falling back to original PDF buffer.`,
      );
      return originalPdfBuffer;
    }
  }

  /**
   * Sanitizes text for standard WinAnsi PDF encoding (used by Helvetica).
   * Strips combining diacritics and converts non-ASCII characters to closest Latin representation.
   */
  private sanitizeForPdf(text: string): string {
    if (!text) return '';
    return text
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // remove combining diacritical marks
      .replace(/[đĐ]/g, (m) => (m === 'đ' ? 'd' : 'D'))
      .replace(/[^\x20-\x7E\xA0-\xFF]/g, ' ') // replace non-Latin1 chars with space
      .trim();
  }
}
