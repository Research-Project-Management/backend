import { Injectable, Logger } from '@nestjs/common';
import { renderPageAsImage } from 'unpdf';
import sharp from 'sharp';

export interface ThumbnailOptions {
  width?: number;
  height?: number;
  quality?: number;
}

export interface ImageThumbnailResult {
  buffer: Buffer;
  mimeType: 'image/webp';
  width?: number;
  height?: number;
  format?: string;
}

@Injectable()
export class ThumbnailService {
  private readonly logger = new Logger(ThumbnailService.name);

  async generateImageThumbnail(
    imageBuffer: Buffer,
    options: ThumbnailOptions = {},
  ): Promise<ImageThumbnailResult | null> {
    if (!imageBuffer || imageBuffer.length === 0) {
      return null;
    }

    const targetWidth = options.width ?? 250;
    const targetHeight = options.height ?? 250;
    const quality = options.quality ?? 80;

    try {
      const metadata = await sharp(imageBuffer).metadata();
      const buffer = await sharp(imageBuffer)
        .resize(targetWidth, targetHeight, {
          fit: 'cover',
          withoutEnlargement: true,
        })
        .webp({ quality })
        .toBuffer();

      return {
        buffer,
        mimeType: 'image/webp',
        width: metadata.width,
        height: metadata.height,
        format: metadata.format,
      };
    } catch (err: unknown) {
      this.logger.warn(
        `Failed to generate in-process image thumbnail: ${(err as Error)?.message}`,
      );
      return null;
    }
  }

  async generateThumbnail(
    pdfBuffer: Buffer,
    options: ThumbnailOptions = {},
  ): Promise<Buffer | null> {
    if (!pdfBuffer || pdfBuffer.length === 0) {
      return null;
    }

    if (!pdfBuffer.subarray(0, 5).toString('utf-8').startsWith('%PDF')) {
      this.logger.debug(
        'Buffer does not contain valid PDF magic header (%PDF).',
      );
      return null;
    }

    const targetWidth = options.width ?? 300;
    const targetHeight = options.height ?? 420;
    const quality = options.quality ?? 80;

    try {
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
    } catch (err: unknown) {
      this.logger.warn(
        `Failed to generate in-process PDF thumbnail: ${(err as Error)?.message}`,
      );
      return null;
    }
  }
}
