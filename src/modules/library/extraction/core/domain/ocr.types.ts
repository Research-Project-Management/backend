/**
 * ocr.types.ts
 * Type definitions for Production-grade OCR subsystem in Flux Library.
 */

export interface OcrBoundingBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OcrWord {
  text: string;
  confidence: number; // 0 to 100
  bbox: OcrBoundingBox;
}

export interface OcrLine {
  text: string;
  confidence: number;
  bbox: OcrBoundingBox;
  words: OcrWord[];
}

export interface OcrBlock {
  text: string;
  confidence: number;
  bbox: OcrBoundingBox;
  lines: OcrLine[];
}

export interface OcrPageResult {
  pageIndex: number; // 0-based index
  text: string;
  confidence: number; // 0 to 100
  orientationAngle: number; // 0, 90, 180, 270
  skewAngle: number; // fine deskew angle in degrees
  languageDetected?: string;
  preprocessed: boolean;
  executionTimeMs: number;
  blocks: OcrBlock[];
  words: OcrWord[];
  wasOcr: boolean;
  imageWidth?: number;
  imageHeight?: number;
}

export interface OcrDocumentResult {
  pages: OcrPageResult[];
  combinedText: string;
  avgConfidence: number;
  totalOcrPages: number;
  executionTimeMs: number;
  searchablePdfBuffer?: Buffer;
}

export interface OcrPreprocessOptions {
  autoRotate?: boolean;
  deskew?: boolean;
  contrastEnhance?: boolean;
  denoise?: boolean;
  binarize?: boolean;
  trimBorders?: boolean;
}

export interface OcrWorkerPoolOptions {
  concurrency?: number;
  languages?: string[];
  langPath?: string;
  jobTimeoutMs?: number;
}

export interface PageScanDetection {
  pageIndex: number;
  isScanned: boolean;
  isHybrid: boolean;
  textLength: number;
  textDensityRatio: number;
  hasLargeImage: boolean;
  reason: string;
}
