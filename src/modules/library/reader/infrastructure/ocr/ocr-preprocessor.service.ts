import { Injectable, Logger } from '@nestjs/common';
import sharp from 'sharp';
import { OcrPreprocessOptions } from './ocr.types';

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

  /**
   * Complete image preprocessing pipeline for scanned documents:
   * 1. Auto-orient / rotate
   * 2. Deskew (horizontal projection profile analysis)
   * 3. Grayscale conversion & contrast normalization
   * 4. Median noise filtering (speckle removal)
   * 5. Adaptive thresholding / binarization
   */
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

    // 1. Auto-orient
    if (opts.autoRotate) {
      pipeline = pipeline.rotate(); // auto-rotate based on EXIF
    }

    // 2. Deskew detection & correction
    if (opts.deskew && currentWidth > 100 && currentHeight > 100) {
      try {
        skewAngle = await this.estimateDeskewAngle(imageBuffer);
        if (Math.abs(skewAngle) >= 0.5) {
          pipeline = pipeline.rotate(-skewAngle, { background: '#ffffff' });
          this.logger.debug(
            `Deskew applied: rotated ${(-skewAngle).toFixed(1)}° to correct scan skew`,
          );
        }
      } catch (err: any) {
        this.logger.debug(`Deskew calculation skipped: ${err?.message || err}`);
      }
    }

    // 3. Grayscale & Contrast Normalization
    pipeline = pipeline.removeAlpha().grayscale();

    if (opts.contrastEnhance) {
      // Linear contrast stretching: stretch darkest to near-black, brightest to pure white
      pipeline = pipeline.normalize().linear(1.15, -10);
    }

    // 4. Denoise: 3x3 median filter removes scanner speckles without blurring sharp text edges
    if (opts.denoise) {
      pipeline = pipeline.median(1);
    }

    // 5. Binarization: threshold separation (text becomes pure black on pure white)
    if (opts.binarize) {
      pipeline = pipeline.threshold(160);
    }

    // 6. Margin trimming if requested
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

  /**
   * Fast deskew angle estimation via Horizontal Projection Profile variance.
   * A document with text lines has maximum variance in row pixel intensities
   * when its text lines are perfectly horizontal.
   */
  async estimateDeskewAngle(
    imageBuffer: Buffer,
    minAngle = -10,
    maxAngle = 10,
    step = 1,
  ): Promise<number> {
    // Generate a lightweight, downsampled grayscale binary thumbnail (width ~ 400px)
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

    // Evaluate candidate angles
    for (let angle = minAngle; angle <= maxAngle; angle += step) {
      const rad = (angle * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const rowSums = new Float64Array(height);
      const rowCounts = new Int32Array(height);

      // Sample a grid of pixels
      const stepX = 2;
      const stepY = 2;
      const midX = width / 2;
      const midY = height / 2;

      for (let y = 0; y < height; y += stepY) {
        for (let x = 0; x < width; x += stepX) {
          const pixelVal = data[y * width + x];
          // Black pixel = ink/text (0), White pixel = background (255)
          const isDark = pixelVal < 128 ? 1 : 0;

          // Projected y-coordinate after rotation around center
          const dx = x - midX;
          const dy = y - midY;
          const rotY = Math.round(midY - dx * sin + dy * cos);

          if (rotY >= 0 && rotY < height) {
            rowSums[rotY] += isDark;
            rowCounts[rotY]++;
          }
        }
      }

      // Compute variance of rowSums
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
