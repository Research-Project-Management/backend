import { Injectable, Logger, Optional } from '@nestjs/common';
import { createCanvas } from '@napi-rs/canvas';
import { OcrPreprocessorService } from '../services/ocr-preprocessor.service';
import { OcrWorkerPoolService } from '../services/ocr-worker-pool.service';
import { OcrSandwichPdfService } from '../services/ocr-sandwich-pdf.service';
import {
  OcrPageResult,
  OcrPreprocessOptions,
  PageScanDetection,
} from '../types/ocr.types';

export interface PdfPageProxyLike {
  getViewport(params: { scale: number }): { width: number; height: number };
  render(params: {
    canvas?: unknown;
    canvasContext?: unknown;
    viewport: unknown;
  }): { promise: Promise<unknown> };
}

/**
 * Production-grade OCR Provider for Flux Library.
 * Features:
 * - Smart hybrid page detection (sparse text + scanned images).
 * - Multi-worker concurrent scheduling via OcrWorkerPoolService.
 * - Comprehensive image preprocessing (deskew, contrast, denoise, binarize).
 * - Searchable "Sandwich" PDF generation for downstream structured extraction.
 * - Word & line bounding boxes and confidence score provenance.
 */
@Injectable()
export class OcrProvider {
  private readonly logger = new Logger(OcrProvider.name);

  constructor(
    @Optional() private readonly workerPool?: OcrWorkerPoolService,
    @Optional() private readonly preprocessor?: OcrPreprocessorService,
    @Optional() private readonly sandwichPdf?: OcrSandwichPdfService,
  ) {}

  get enabled(): boolean {
    const value = process.env.PDF_OCR_ENABLED;
    return value !== 'false' && value !== '0';
  }

  get maxPages(): number {
    const parsed = Number.parseInt(process.env.PDF_OCR_MAX_PAGES || '200', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 200;
  }

  get renderScale(): number {
    const envScale = Number.parseFloat(process.env.PDF_OCR_RENDER_SCALE || '3');
    return Number.isFinite(envScale) && envScale >= 1 && envScale <= 4
      ? envScale
      : 3;
  }

  /**
   * Evaluates whether a PDF page is image-only, hybrid, or born-digital.
   */
  async detectScannedPage(
    page: any,
    textContent?: any,
  ): Promise<PageScanDetection> {
    const content = textContent || (await page.getTextContent());
    const items = content?.items || [];
    const text = items
      .map((it: any) => it.str || '')
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

  /**
   * Performs full OCR recognition on a single PDF page with image preprocessing and worker pool.
   */
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
      const canvasContext = canvas.getContext('2d');
      await page.render({
        canvas,
        canvasContext,
        viewport,
      }).promise;

      const rawBuffer = canvas.toBuffer('image/png');

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
      let words: any[] = [];
      let blocks: any[] = [];

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
    } catch (error: any) {
      this.logger.warn(
        `OCR page recognition failed on page ${pageIndex + 1}: ${error?.message || error}`,
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
