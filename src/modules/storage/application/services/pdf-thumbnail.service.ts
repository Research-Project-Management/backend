import { Injectable, Logger } from '@nestjs/common';
import { renderPageAsImage } from 'unpdf';
import sharp from 'sharp';

export interface ThumbnailOptions {
  width?: number;
  height?: number;
  quality?: number;
}

@Injectable()
export class PdfThumbnailService {
  private readonly logger = new Logger(PdfThumbnailService.name);

  /**
   * Renders the first page of a PDF buffer into a lightweight WebP thumbnail image.
   * Runs 100% in-process using Mozilla PDF.js (unpdf), @napi-rs/canvas, and sharp.
   */
  async generateThumbnail(
    pdfBuffer: Buffer,
    options: ThumbnailOptions = {},
  ): Promise<Buffer | null> {
    if (!pdfBuffer || pdfBuffer.length === 0) {
      return null;
    }

    // Validate PDF magic number (%PDF)
    if (!pdfBuffer.subarray(0, 5).toString('utf-8').startsWith('%PDF')) {
      this.logger.debug('Buffer does not contain valid PDF magic header (%PDF).');
      return null;
    }

    const targetWidth = options.width ?? 300;
    const targetHeight = options.height ?? 420;
    const quality = options.quality ?? 80;

    try {
      // 1. Render page 1 to an image buffer via PDF.js and @napi-rs/canvas
      // Mozilla PDF.js v5 requires pure Uint8Array instance rather than Buffer
      const uint8ArrayData = new Uint8Array(
        pdfBuffer.buffer,
        pdfBuffer.byteOffset,
        pdfBuffer.byteLength,
      );
      const pageImageBuffer = await renderPageAsImage(uint8ArrayData, 1, {
        canvasImport: () => import('@napi-rs/canvas'),
      });

      if (!pageImageBuffer || pageImageBuffer.byteLength === 0) {
        this.logger.debug('PDF page rendering returned empty image buffer.');
        return null;
      }

      // 2. Process and compress with sharp into modern WebP
      const webpBuffer = await sharp(Buffer.from(pageImageBuffer))
        .resize(targetWidth, targetHeight, {
          fit: 'cover',
          position: 'top',
          withoutEnlargement: true,
        })
        .webp({ quality, effort: 4 })
        .toBuffer();

      this.logger.debug(
        `Generated WebP thumbnail (${webpBuffer.length} bytes) for PDF (${pdfBuffer.length} bytes).`,
      );

      return webpBuffer;
    } catch (err: any) {
      this.logger.warn(
        `Failed to generate in-process PDF thumbnail: ${err?.message}`,
      );
      return null;
    }
  }
}
