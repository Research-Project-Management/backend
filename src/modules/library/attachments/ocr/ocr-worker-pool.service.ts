import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import path from 'path';
import fs from 'fs';
import { createScheduler, createWorker, Scheduler, Worker } from 'tesseract.js';
import {
  OcrBlock,
  OcrBoundingBox,
  OcrWord,
  OcrWorkerPoolOptions,
} from './ocr.types';

export interface RawOcrRecognitionResult {
  text: string;
  confidence: number;
  words: OcrWord[];
  blocks: OcrBlock[];
}

@Injectable()
export class OcrWorkerPoolService implements OnModuleDestroy {
  private readonly logger = new Logger(OcrWorkerPoolService.name);
  private scheduler?: Scheduler;
  private workers: Worker[] = [];
  private initPromise?: Promise<void>;
  private isDestroyed = false;

  get concurrency(): number {
    const parsed = Number.parseInt(
      process.env.PDF_OCR_CONCURRENCY || '2',
      10,
    );
    return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 4) : 2;
  }

  get defaultLanguages(): string[] {
    const envLangs = process.env.PDF_OCR_LANGUAGES;
    if (envLangs) {
      return envLangs
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    // Default to Vietnamese + English for Flux academic research platform
    return ['vie', 'eng'];
  }

  get defaultLangPath(): string {
    if (process.env.TESSERACT_LANG_PATH) {
      return process.env.TESSERACT_LANG_PATH;
    }
    // Check local tessdata directory in backend root
    const localTessdata = path.resolve(process.cwd(), 'tessdata');
    if (fs.existsSync(localTessdata)) {
      return localTessdata;
    }
    // Fallback to relative path from dist/src
    const relativeTessdata = path.resolve(__dirname, '../../../../../../tessdata');
    if (fs.existsSync(relativeTessdata)) {
      return relativeTessdata;
    }
    return localTessdata;
  }

  /**
   * Initializes the Tesseract Worker Pool lazily.
   */
  async ensureInitialized(options: OcrWorkerPoolOptions = {}): Promise<void> {
    if (this.isDestroyed) {
      throw new Error('OcrWorkerPoolService has been destroyed');
    }

    if (this.scheduler && this.workers.length > 0) {
      return;
    }

    if (!this.initPromise) {
      this.initPromise = this.createPool(options).catch((err) => {
        this.initPromise = undefined;
        this.scheduler = undefined;
        this.workers = [];
        throw err;
      });
    }

    await this.initPromise;
  }

  private async createPool(options: OcrWorkerPoolOptions): Promise<void> {
    const targetConcurrency = options.concurrency ?? this.concurrency;
    const languages = options.languages ?? this.defaultLanguages;
    const langPath = options.langPath ?? this.defaultLangPath;

    this.logger.log(
      `Initializing Tesseract Worker Pool (Concurrency: ${targetConcurrency}, Languages: [${languages.join(', ')}], LangPath: "${langPath}")`,
    );

    const scheduler = createScheduler();
    const createdWorkers: Worker[] = [];

    try {
      for (let i = 0; i < targetConcurrency; i++) {
        const worker = await createWorker(
          languages,
          undefined,
          langPath ? { langPath, cachePath: langPath } : undefined,
        );
        scheduler.addWorker(worker);
        createdWorkers.push(worker);
      }

      this.scheduler = scheduler;
      this.workers = createdWorkers;
      this.logger.log(
        `Tesseract Worker Pool successfully online with ${createdWorkers.length} active workers.`,
      );
    } catch (error: any) {
      this.logger.error(
        `Failed to initialize Tesseract Worker Pool: ${error?.message || error}`,
      );
      // Clean up any partially created workers
      for (const w of createdWorkers) {
        try {
          await w.terminate();
        } catch {
          // ignore cleanup errors
        }
      }
      throw error;
    }
  }

  /**
   * Recognizes text and layout bounding boxes from an image buffer using the worker pool.
   * Includes per-job timeout to prevent pipeline stalls.
   */
  async recognize(
    imageBuffer: Buffer,
    timeoutMs = 35000,
  ): Promise<RawOcrRecognitionResult> {
    await this.ensureInitialized();

    if (!this.scheduler) {
      throw new Error('Tesseract Scheduler is not initialized');
    }

    const jobPromise = this.scheduler.addJob(
      'recognize',
      imageBuffer,
      {},
      {
        text: true,
        blocks: true,
      },
    );

    const timeoutPromise = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `OCR recognition timed out after ${timeoutMs / 1000}s on worker pool`,
          ),
        );
      }, timeoutMs);
      jobPromise.finally(() => clearTimeout(timer));
    });

    const result = (await Promise.race([
      jobPromise,
      timeoutPromise,
    ])) as any;

    const data = result?.data || {};
    const text = (data.text || '').trim();
    const confidence = Number(data.confidence) || 0;

    // Extract structured words with bounding boxes
    const words: OcrWord[] = [];
    if (Array.isArray(data.words)) {
      for (const w of data.words) {
        if (!w.text || !w.text.trim()) continue;
        const bbox: OcrBoundingBox = {
          x0: w.bbox?.x0 ?? 0,
          y0: w.bbox?.y0 ?? 0,
          x1: w.bbox?.x1 ?? 0,
          y1: w.bbox?.y1 ?? 0,
        };
        words.push({
          text: w.text.trim(),
          confidence: Number(w.confidence) || 0,
          bbox,
        });
      }
    }

    // Extract structured blocks and lines
    const blocks: OcrBlock[] = [];
    if (Array.isArray(data.blocks)) {
      for (const b of data.blocks) {
        const blockBbox: OcrBoundingBox = {
          x0: b.bbox?.x0 ?? 0,
          y0: b.bbox?.y0 ?? 0,
          x1: b.bbox?.x1 ?? 0,
          y1: b.bbox?.y1 ?? 0,
        };

        const lines = Array.isArray(b.lines)
          ? b.lines.map((l: any) => ({
              text: (l.text || '').trim(),
              confidence: Number(l.confidence) || 0,
              bbox: {
                x0: l.bbox?.x0 ?? 0,
                y0: l.bbox?.y0 ?? 0,
                x1: l.bbox?.x1 ?? 0,
                y1: l.bbox?.y1 ?? 0,
              },
              words: Array.isArray(l.words)
                ? l.words.map((w: any) => ({
                    text: (w.text || '').trim(),
                    confidence: Number(w.confidence) || 0,
                    bbox: {
                      x0: w.bbox?.x0 ?? 0,
                      y0: w.bbox?.y0 ?? 0,
                      x1: w.bbox?.x1 ?? 0,
                      y1: w.bbox?.y1 ?? 0,
                    },
                  }))
                : [],
            }))
          : [];

        blocks.push({
          text: (b.text || '').trim(),
          confidence: Number(b.confidence) || 0,
          bbox: blockBbox,
          lines,
        });
      }
    }

    return {
      text,
      confidence,
      words,
      blocks,
    };
  }

  /**
   * Gracefully terminate the pool and release WASM memory upon NestJS application shutdown.
   */
  async onModuleDestroy(): Promise<void> {
    this.isDestroyed = true;
    if (this.scheduler) {
      this.logger.log('Gracefully terminating Tesseract Worker Pool...');
      try {
        await this.scheduler.terminate();
      } catch (err: any) {
        this.logger.warn(
          `Error terminating Tesseract scheduler: ${err?.message || err}`,
        );
      }
      this.scheduler = undefined;
      this.workers = [];
      this.initPromise = undefined;
    }
  }
}
