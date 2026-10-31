import { Injectable, Logger, Optional } from '@nestjs/common';
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import sharp from 'sharp';
import os from 'os';
import {
  libraryConfig,
  LibraryConfigService,
} from '@/modules/library/core/config/library.config';
import { OcrWorkerPoolService } from '@/modules/library/extraction/services/ocr-worker-pool.service';
import {
  OcrBlock,
  OcrPageResult,
  OcrPreprocessOptions,
  OcrWord,
  PageScanDetection,
} from '@/modules/library/extraction/types/extraction.types';

try {
  sharp.cache({ memory: 64, items: 250, files: 20 });
  sharp.simd(true);
  const safeConcurrency = Math.max(
    1,
    Math.min(4, (os.cpus()?.length || 2) - 1),
  );
  sharp.concurrency(safeConcurrency);
} catch {
  // Graceful fallback if native libvips binding restricts re-configuration
}

export interface PreprocessResult {
  buffer: Buffer;
  orientationAngle: number;
  skewAngle: number;
  width: number;
  height: number;
}

@Injectable()
export class OcrPreprocessorService {
  private readonly logger = new Logger(OcrPreprocessorService.name);

  async preprocess(
    imageBuffer: Buffer,
    options: OcrPreprocessOptions = {},
  ): Promise<PreprocessResult> {
    const startTime = Date.now();
    const opts: Required<OcrPreprocessOptions> = {
      autoRotate: options.autoRotate ?? true,
      deskew: options.deskew ?? true,
      contrastEnhance: options.contrastEnhance ?? true,
      denoise: options.denoise ?? true,
      binarize: options.binarize ?? true,
      trimBorders: options.trimBorders ?? false,
    };

    let pipeline = sharp(imageBuffer);
    const metadata = await pipeline.metadata();
    const currentWidth = metadata.width || 1000;
    const currentHeight = metadata.height || 1400;
    const orientationAngle = 0;
    let skewAngle = 0;

    if (opts.autoRotate) {
      pipeline = pipeline.rotate();
    }

    if (opts.deskew && currentWidth > 100 && currentHeight > 100) {
      try {
        skewAngle = await this.estimateDeskewAngle(imageBuffer);
        if (Math.abs(skewAngle) >= 0.5) {
          pipeline = pipeline.rotate(-skewAngle, { background: '#ffffff' });
          this.logger.debug(
            `Deskew applied: rotated ${(-skewAngle).toFixed(1)}° to correct scan skew`,
          );
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.debug(`Deskew calculation skipped: ${message}`);
      }
    }

    pipeline = pipeline.removeAlpha().grayscale();

    if (opts.contrastEnhance) {
      pipeline = pipeline.normalize().linear(1.15, -10);
    }

    if (opts.denoise) {
      pipeline = pipeline.median(1);
    }

    if (opts.binarize) {
      pipeline = pipeline.threshold(160);
    }

    if (opts.trimBorders) {
      pipeline = pipeline.trim({ threshold: 25 });
    }

    const { data: processedBuffer, info: processedInfo } = await pipeline
      .png()
      .toBuffer({ resolveWithObject: true });

    this.logger.debug(
      `Image preprocessed in ${Date.now() - startTime}ms (${processedInfo.width}x${processedInfo.height})`,
    );

    return {
      buffer: processedBuffer,
      orientationAngle,
      skewAngle,
      width: processedInfo.width || currentWidth,
      height: processedInfo.height || currentHeight,
    };
  }

  async estimateDeskewAngle(
    imageBuffer: Buffer,
    minAngle = -10,
    maxAngle = 10,
    step = 1,
  ): Promise<number> {
    const thumbWidth = 400;
    const thumbBuffer = await sharp(imageBuffer)
      .resize({ width: thumbWidth, withoutEnlargement: true })
      .grayscale()
      .normalize()
      .threshold(160)
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { data, info } = thumbBuffer;
    const { width, height } = info;

    let bestAngle = 0;
    let maxVariance = -1;

    for (let angle = minAngle; angle <= maxAngle; angle += step) {
      const rad = (angle * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const rowSums = new Float64Array(height);
      const rowCounts = new Int32Array(height);

      const stepX = 2;
      const stepY = 2;
      const midX = width / 2;
      const midY = height / 2;

      for (let y = 0; y < height; y += stepY) {
        for (let x = 0; x < width; x += stepX) {
          const pixelVal = data[y * width + x];
          const isDark = pixelVal < 128 ? 1 : 0;

          const dx = x - midX;
          const dy = y - midY;
          const rotY = Math.round(midY - dx * sin + dy * cos);

          if (rotY >= 0 && rotY < height) {
            rowSums[rotY] += isDark;
            rowCounts[rotY]++;
          }
        }
      }

      let sum = 0;
      let sumSq = 0;
      let count = 0;
      for (let i = 0; i < height; i++) {
        if (rowCounts[i] > 0) {
          const density = rowSums[i] / rowCounts[i];
          sum += density;
          sumSq += density * density;
          count++;
        }
      }

      if (count > 0) {
        const mean = sum / count;
        const variance = sumSq / count - mean * mean;
        if (variance > maxVariance) {
          maxVariance = variance;
          bestAngle = angle;
        }
      }
    }

    return bestAngle;
  }
}

@Injectable()
export class OcrSandwichPdfService {
  private readonly logger = new Logger(OcrSandwichPdfService.name);

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

        if (pageResult.words && pageResult.words.length > 0) {
          for (const word of pageResult.words) {
            const sanitized = this.sanitizeForPdf(word.text);
            if (!sanitized) continue;

            const boxHeight = Math.max(
              1,
              (word.bbox.y1 - word.bbox.y0) * scaleY,
            );
            const pdfX = Math.max(0, word.bbox.x0 * scaleX);
            const pdfY = Math.max(0, pdfHeight - word.bbox.y1 * scaleY);
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
              // Ignore word drawing error
            }
          }
        } else {
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
      const resultBuffer = Buffer.from(
        pdfBytes.buffer,
        pdfBytes.byteOffset,
        pdfBytes.byteLength,
      );
      this.logger.log(
        `Generated Searchable Sandwich PDF for ${ocrPages.length} scanned pages in ${Date.now() - startTime}ms (size: ${(resultBuffer.length / 1024).toFixed(1)} KB)`,
      );
      return resultBuffer;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Failed to generate searchable Sandwich PDF: ${message}. Falling back to original PDF buffer.`,
      );
      return originalPdfBuffer;
    }
  }

  private sanitizeForPdf(text: string): string {
    if (!text) return '';
    return text
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[đĐ]/g, (m) => (m === 'đ' ? 'd' : 'D'))
      .replace(/[^\x20-\x7E\xA0-\xFF]/g, ' ')
      .trim();
  }
}

export interface PdfPageProxyLike {
  getViewport(params: { scale: number }): { width: number; height: number };
  render(params: {
    canvas?: unknown;
    canvasContext?: unknown;
    viewport: unknown;
  }): { promise: Promise<unknown> };
  cleanup?: () => void;
}

@Injectable()
export class OcrProvider {
  private readonly logger = new Logger(OcrProvider.name);
  private readonly preprocessor?: OcrPreprocessorService;
  private readonly sandwichPdf?: OcrSandwichPdfService;

  constructor(
    @Optional() private readonly workerPool?: OcrWorkerPoolService,
    @Optional() preprocessor?: OcrPreprocessorService,
    @Optional() sandwichPdf?: OcrSandwichPdfService,
    @Optional() private readonly configService?: LibraryConfigService,
  ) {
    this.preprocessor = preprocessor;
    this.sandwichPdf = sandwichPdf;
  }

  get enabled(): boolean {
    const value =
      this.configService?.ocr.enabled ?? libraryConfig().ocr.enabled;
    return value !== 'false' && value !== '0';
  }

  get maxPages(): number {
    const parsed =
      this.configService?.ocr.maxPages ?? libraryConfig().ocr.maxPages;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 200;
  }

  get renderScale(): number {
    const envScale =
      this.configService?.ocr.renderScale ?? libraryConfig().ocr.renderScale;
    return Number.isFinite(envScale) && envScale >= 1 && envScale <= 4
      ? envScale
      : 3;
  }

  async detectScannedPage(
    page: {
      pageNumber?: number;
      getTextContent: () => Promise<{ items?: Array<{ str?: string }> }>;
      getOperatorList?: () => Promise<{ fnArray: number[] }>;
    },
    textContent?: { items?: Array<{ str?: string }> },
  ): Promise<PageScanDetection> {
    const content = textContent || (await page.getTextContent());
    const items = content?.items || [];
    const text = items
      .map((it: { str?: string }) => it.str || '')
      .join('')
      .trim();
    const textLength = text.length;

    if (textLength < 32) {
      return {
        pageIndex: page.pageNumber ? page.pageNumber - 1 : 0,
        isScanned: true,
        isHybrid: false,
        textLength,
        textDensityRatio: 0,
        hasLargeImage: true,
        reason: 'Sparse text layer (< 32 chars)',
      };
    }

    if (textLength < 150) {
      let hasImage = false;
      try {
        if (typeof page.getOperatorList === 'function') {
          const ops = await page.getOperatorList();
          hasImage = ops.fnArray.some(
            (fn: number) => fn === 85 || fn === 82 || fn === 86,
          );
        }
      } catch {
        hasImage = true;
      }

      return {
        pageIndex: page.pageNumber ? page.pageNumber - 1 : 0,
        isScanned: false,
        isHybrid: true,
        textLength,
        textDensityRatio: textLength / 2000,
        hasLargeImage: hasImage,
        reason:
          'Hybrid page: sparse text (< 150 chars) with potential scanned document body',
      };
    }

    return {
      pageIndex: page.pageNumber ? page.pageNumber - 1 : 0,
      isScanned: false,
      isHybrid: false,
      textLength,
      textDensityRatio: textLength / 2500,
      hasLargeImage: false,
      reason: 'Standard digital text layer',
    };
  }

  async recognizeScannedPdfPages(
    pages: PdfPageProxyLike[],
    options?: OcrPreprocessOptions,
  ): Promise<OcrPageResult[]> {
    const results: OcrPageResult[] = [];
    const limit = Math.min(pages.length, this.maxPages);
    for (let i = 0; i < limit; i++) {
      const res = await this.recognizePdfPage(pages[i], i, options);
      results.push(res);
      if ((i + 1) % 5 === 0) {
        await new Promise((r) => setImmediate(r));
      }
    }
    return results;
  }

  async renderPdfPageToImage(page: PdfPageProxyLike): Promise<{
    buffer: Buffer;
    width: number;
    height: number;
  }> {
    let scale = this.renderScale;
    let viewport = page.getViewport({ scale });
    const maxDim = Math.max(viewport.width, viewport.height);
    if (maxDim > 4096) {
      scale = scale * (4096 / maxDim);
      viewport = page.getViewport({ scale });
    }

    const canvasWidth = Math.max(1, Math.ceil(viewport.width));
    const canvasHeight = Math.max(1, Math.ceil(viewport.height));
    const canvas = createCanvas(canvasWidth, canvasHeight);
    try {
      const canvasContext = canvas.getContext('2d');
      await page.render({
        canvas,
        canvasContext,
        viewport,
      }).promise;

      const rawBuffer = canvas.toBuffer('image/png');
      return {
        buffer: rawBuffer,
        width: canvasWidth,
        height: canvasHeight,
      };
    } finally {
      canvas.width = 0;
      canvas.height = 0;
      page?.cleanup?.();
    }
  }

  async recognizePdfPage(
    page: PdfPageProxyLike,
    pageIndex = 0,
    options?: OcrPreprocessOptions,
  ): Promise<OcrPageResult> {
    if (!this.enabled) {
      return this.createEmptyResult(pageIndex);
    }

    const startTime = Date.now();

    try {
      const {
        buffer: rawBuffer,
        width: canvasWidth,
        height: canvasHeight,
      } = await this.renderPdfPageToImage(page);

      let processedBuffer = rawBuffer;
      let orientationAngle = 0;
      let skewAngle = 0;

      if (this.preprocessor) {
        const prep = await this.preprocessor.preprocess(rawBuffer, options);
        processedBuffer = prep.buffer;
        orientationAngle = prep.orientationAngle;
        skewAngle = prep.skewAngle;
      }

      let text = '';
      let confidence = 0;
      let words: OcrWord[] = [];
      let blocks: OcrBlock[] = [];

      if (this.workerPool) {
        const recognition = await this.workerPool.recognize(processedBuffer);
        text = recognition.text;
        confidence = recognition.confidence;
        words = recognition.words;
        blocks = recognition.blocks;
      }

      const executionTimeMs = Date.now() - startTime;
      this.logger.debug(
        `OCR recognized page ${pageIndex + 1}: ${text.length} chars (Confidence: ${confidence.toFixed(1)}%, Skew: ${skewAngle}°) in ${executionTimeMs}ms`,
      );

      return {
        pageIndex,
        text,
        confidence,
        orientationAngle,
        skewAngle,
        preprocessed: true,
        executionTimeMs,
        blocks,
        words,
        wasOcr: true,
        imageWidth: canvasWidth,
        imageHeight: canvasHeight,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `OCR page recognition failed on page ${pageIndex + 1}: ${message}`,
      );
      return this.createEmptyResult(pageIndex);
    }
  }

  async generateSearchablePdf(
    originalBuffer: Buffer,
    pageResults: OcrPageResult[],
    dimensionsMap?: Map<number, { width: number; height: number }>,
  ): Promise<Buffer> {
    if (!this.sandwichPdf) {
      return originalBuffer;
    }
    return this.sandwichPdf.generateSearchablePdf(
      originalBuffer,
      pageResults,
      dimensionsMap,
    );
  }

  private createEmptyResult(pageIndex: number): OcrPageResult {
    return {
      pageIndex,
      text: '',
      confidence: 0,
      orientationAngle: 0,
      skewAngle: 0,
      preprocessed: false,
      executionTimeMs: 0,
      blocks: [],
      words: [],
      wasOcr: false,
    };
  }
}
