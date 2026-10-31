import {
  Injectable,
  Logger,
  OnModuleDestroy,
  BeforeApplicationShutdown,
  Optional,
} from '@nestjs/common';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { createScheduler, createWorker, Scheduler, Worker } from 'tesseract.js';
import {
  OcrBlock,
  OcrBoundingBox,
  OcrWord,
  OcrWorkerPoolOptions,
} from '@/modules/library/extraction/types/extraction.types';
import {
  SubsystemUnavailableException,
  LibraryConfigService,
  libraryConfig,
} from '@/modules/library/core';

export interface RawOcrRecognitionResult {
  text: string;
  confidence: number;
  words: OcrWord[];
  blocks: OcrBlock[];
}

@Injectable()
export class OcrWorkerPoolService
  implements OnModuleDestroy, BeforeApplicationShutdown
{
  private readonly logger = new Logger(OcrWorkerPoolService.name);
  private scheduler?: Scheduler;
  private workers: Worker[] = [];
  private initPromise?: Promise<void>;
  private isDestroyed = false;

  constructor(
    @Optional() private readonly configService?: LibraryConfigService,
  ) {}

  getPoolStatus(): {
    initialized: boolean;
    destroyed: boolean;
    activeWorkers: number;
    configuredConcurrency: number;
    defaultLanguages: string[];
  } {
    return {
      initialized: Boolean(this.scheduler && this.workers.length > 0),
      destroyed: this.isDestroyed,
      activeWorkers: this.workers.length,
      configuredConcurrency: this.concurrency,
      defaultLanguages: this.defaultLanguages,
    };
  }

  get concurrency(): number {
    const parsed =
      this.configService?.ocr.concurrency ?? libraryConfig().ocr.concurrency;
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(parsed, 4);
    }
    // OS Core & Memory Aware Safe Concurrency
    const cpuCores = os.cpus()?.length || 2;
    const freeMemMB = os.freemem() / (1024 * 1024);
    const memoryMaxWorkers = Math.max(1, Math.floor(freeMemMB / 250));
    const coreMaxWorkers = Math.max(1, cpuCores - 1);
    return Math.max(1, Math.min(2, coreMaxWorkers, memoryMaxWorkers));
  }

  get defaultLanguages(): string[] {
    const envLangs =
      this.configService?.ocr.languages ?? libraryConfig().ocr.languages;
    if (envLangs) {
      return envLangs
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    return ['vie', 'eng'];
  }

  get defaultLangPath(): string {
    const customPath =
      this.configService?.ocr.tesseractLangPath ??
      libraryConfig().ocr.tesseractLangPath;
    if (customPath) {
      return customPath;
    }
    const localTessdata = path.resolve(process.cwd(), 'tessdata');
    if (fs.existsSync(localTessdata)) {
      return localTessdata;
    }
    const relativeTessdata = path.resolve(
      __dirname,
      '../../../../../../tessdata',
    );
    if (fs.existsSync(relativeTessdata)) {
      return relativeTessdata;
    }
    return localTessdata;
  }

  async ensureInitialized(options: OcrWorkerPoolOptions = {}): Promise<void> {
    if (this.isDestroyed) {
      throw new SubsystemUnavailableException(
        'OcrWorkerPoolService has been destroyed',
        { subsystem: 'OcrWorkerPoolService' },
      );
    }

    if (this.recyclePromise) {
      await this.recyclePromise;
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
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Failed to initialize Tesseract Worker Pool: ${message}`,
      );
      for (const w of createdWorkers) {
        try {
          await w.terminate();
        } catch {
          // ignore
        }
      }
      throw error;
    }
  }

  async recognize(
    imageBuffer: Buffer,
    timeoutMs = 35000,
  ): Promise<RawOcrRecognitionResult> {
    await this.ensureInitialized();

    if (!this.scheduler) {
      throw new SubsystemUnavailableException(
        'Tesseract Scheduler is not initialized',
        { subsystem: 'OcrWorkerPoolService' },
      );
    }

    const activeScheduler = this.scheduler;
    const jobPromise = activeScheduler.addJob(
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
      void jobPromise.finally(() => clearTimeout(timer));
    });

    let result:
      | {
          data?: {
            text?: string;
            confidence?: number;
            words?: Array<{
              text?: string;
              confidence?: number;
              bbox?: { x0?: number; y0?: number; x1?: number; y1?: number };
            }>;
            blocks?: Array<{
              text?: string;
              confidence?: number;
              bbox?: { x0?: number; y0?: number; x1?: number; y1?: number };
              lines?: Array<{
                text?: string;
                confidence?: number;
                bbox?: { x0?: number; y0?: number; x1?: number; y1?: number };
                words?: Array<{
                  text?: string;
                  confidence?: number;
                  bbox?: { x0?: number; y0?: number; x1?: number; y1?: number };
                }>;
              }>;
            }>;
          };
        }
      | undefined;
    try {
      result = (await Promise.race([
        jobPromise,
        timeoutPromise,
      ])) as typeof result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('timed out')) {
        this.logger.warn(
          `OCR recognition timed out after ${timeoutMs}ms. Recycling worker pool to prevent scheduler starvation.`,
        );
        this.recyclePool(activeScheduler).catch((recycleErr: unknown) => {
          this.logger.warn(
            `Failed to recycle worker pool after timeout: ${recycleErr instanceof Error ? recycleErr.message : String(recycleErr)}`,
          );
        });
      }
      throw err;
    }

    const data = result?.data || {};
    const text = (data.text || '').trim();
    const confidence = Number(data.confidence) || 0;

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
          ? b.lines.map((l) => ({
              text: (l.text || '').trim(),
              confidence: Number(l.confidence) || 0,
              bbox: {
                x0: l.bbox?.x0 ?? 0,
                y0: l.bbox?.y0 ?? 0,
                x1: l.bbox?.x1 ?? 0,
                y1: l.bbox?.y1 ?? 0,
              },
              words: Array.isArray(l.words)
                ? l.words.map((w) => ({
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

  private recyclePromise?: Promise<void>;

  async recyclePool(expectedScheduler?: Scheduler): Promise<void> {
    if (expectedScheduler && this.scheduler !== expectedScheduler) {
      return;
    }
    if (this.recyclePromise) {
      return this.recyclePromise;
    }
    this.recyclePromise = this.executePoolRecycle().finally(() => {
      this.recyclePromise = undefined;
    });
    return this.recyclePromise;
  }

  private async executePoolRecycle(): Promise<void> {
    this.logger.warn(
      'Recycling Tesseract Worker Pool due to worker timeout or unrecoverable error...',
    );
    const deadScheduler = this.scheduler;
    const deadWorkers = [...this.workers];
    this.scheduler = undefined;
    this.workers = [];
    this.initPromise = undefined;

    for (const w of deadWorkers) {
      try {
        await w.terminate();
      } catch {
        // ignore individual worker termination failure
      }
    }

    if (deadScheduler) {
      try {
        await deadScheduler.terminate();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.debug(
          `Old Tesseract scheduler termination completed: ${message}`,
        );
      }
    }
  }

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    this.logger.log(
      `Received OS shutdown signal "${signal || 'SIGTERM'}". Terminating Tesseract worker pool...`,
    );
    await this.shutdownPool();
  }

  async onModuleDestroy(): Promise<void> {
    await this.shutdownPool();
  }

  private async shutdownPool(): Promise<void> {
    if (this.isDestroyed) return;
    this.isDestroyed = true;
    const currentScheduler = this.scheduler;
    const currentWorkers = [...this.workers];
    this.scheduler = undefined;
    this.workers = [];
    this.initPromise = undefined;

    for (const w of currentWorkers) {
      try {
        await w.terminate();
      } catch {
        // ignore
      }
    }

    if (currentScheduler) {
      try {
        await currentScheduler.terminate();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Error terminating Tesseract scheduler: ${message}`);
      }
    }
  }
}
