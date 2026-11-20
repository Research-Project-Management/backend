import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { renderPageAsImage } from 'unpdf';
import sharp from 'sharp';
import {
  MAX_CONCURRENT_THUMBNAIL_RENDERS,
  MAX_PDF_THUMBNAIL_BYTES,
  STORAGE_ADAPTER,
} from '../files.constant';
import { StorageKey } from '../domain/storage-vo';
import { streamToBuffer } from '../domain/files.policy';
import { BlobRepository } from '../repositories/blob.repository';
import { IStorageAdapter } from '../types/adapter.type';
import {
  EnsureImageThumbnailOutput,
  getFileObjectPath,
  RequestThumbnailInput,
} from '../types/files.type';
import { BlobService } from './blob.service';

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
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private activeRenders = 0;
  private readonly waitQueue: Array<() => void> = [];

  constructor(
    @Optional()
    @Inject(STORAGE_ADAPTER)
    private readonly driver?: IStorageAdapter,
    @Optional() private readonly blobRepo?: BlobRepository,
    @Optional() private readonly blobService?: BlobService,
  ) {}

  private async acquireSlot(): Promise<void> {
    if (this.activeRenders < MAX_CONCURRENT_THUMBNAIL_RENDERS) {
      this.activeRenders += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waitQueue.push(resolve);
    });
    this.activeRenders += 1;
  }

  private releaseSlot(): void {
    this.activeRenders = Math.max(0, this.activeRenders - 1);
    const next = this.waitQueue.shift();
    if (next) {
      next();
    }
  }

  /**
   * Singleflight coalescer + bounded concurrency semaphore to prevent OOM
   * or event-loop starvation when multiple clients request the same thumbnail.
   */
  public runCoalesced<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key) as Promise<T> | undefined;
    if (existing) {
      return existing;
    }

    const promise = (async () => {
      await this.acquireSlot();
      try {
        return await fn();
      } finally {
        this.releaseSlot();
      }
    })().finally(() => {
      this.inFlight.delete(key);
    });

    this.inFlight.set(key, promise);
    return promise;
  }

  public getThumbnailUrl(blobId: string, contentHashHex?: string): string {
    if (contentHashHex && /^[a-f0-9]{64}$/i.test(contentHashHex)) {
      return getFileObjectPath(
        StorageKey.forDerivative(contentHashHex, 'thumb').value(),
      );
    }
    return getFileObjectPath(`thumbnails/${blobId}.webp`);
  }

  async ensurePdfThumbnail(input: {
    fileId: string;
    userId?: string;
    spaceId?: string | null;
  }): Promise<Buffer | null> {
    if (!this.blobService || !this.driver) {
      return null;
    }

    const blob = this.blobRepo
      ? await this.blobRepo.findById(input.fileId).catch(() => null)
      : null;
    const derivativeKey = blob
      ? StorageKey.forDerivative(blob.contentHashHex, 'thumb').value()
      : null;
    const legacyKey = `thumbnails/${input.fileId}.webp`;
    const primaryKey = derivativeKey ?? legacyKey;

    for (const candidateKey of derivativeKey
      ? [derivativeKey, legacyKey]
      : [legacyKey]) {
      try {
        const exists = await this.driver.exists(candidateKey);
        if (exists) {
          const { stream } = await this.driver.getStream(candidateKey);
          return streamToBuffer(stream);
        }
      } catch {
        // Fall through to next candidate or render
      }
    }

    if (blob && blob.sizeBytes > MAX_PDF_THUMBNAIL_BYTES) {
      this.logger.warn(
        `Skipping PDF thumbnail generation for ${input.fileId} (${blob.sizeBytes} bytes > ${MAX_PDF_THUMBNAIL_BYTES} bytes limit)`,
      );
      return null;
    }

    return this.runCoalesced(primaryKey, async () => {
      const { stream } = await this.blobService!.openStream(input.fileId);
      const pdfBuffer = await streamToBuffer(stream as AsyncIterable<Buffer>);
      const thumbBuffer = await this.generateThumbnail(pdfBuffer);
      if (!thumbBuffer) {
        return null;
      }

      await this.driver!.put(primaryKey, thumbBuffer, {
        mimeType: 'image/webp',
        size: thumbBuffer.length,
      }).catch(() => undefined);

      return thumbBuffer;
    });
  }

  async ensureImageThumbnail(input: {
    fileId: string;
    width?: number;
    height?: number;
    quality?: number;
  }): Promise<EnsureImageThumbnailOutput | null> {
    if (!this.blobService || !this.driver) {
      return null;
    }

    const blob = this.blobRepo
      ? await this.blobRepo.findById(input.fileId).catch(() => null)
      : null;
    const thumbKey = blob
      ? StorageKey.forDerivative(blob.contentHashHex, 'thumb').value()
      : `thumbnails/${input.fileId}.webp`;

    return this.runCoalesced(thumbKey, async () => {
      const { stream } = await this.blobService!.openStream(input.fileId);
      const buffer = await streamToBuffer(stream as AsyncIterable<Buffer>);
      const result = await this.generateImageThumbnail(buffer, {
        width: input.width,
        height: input.height,
        quality: input.quality,
      });
      if (!result) {
        return null;
      }

      await this.driver!.put(thumbKey, result.buffer, {
        mimeType: result.mimeType,
        size: result.buffer.length,
      }).catch(() => undefined);

      return {
        thumbnailUrl: getFileObjectPath(thumbKey),
        width: result.width,
        height: result.height,
        format: result.format,
      };
    });
  }

  async generateAndCacheDerivative(
    input: RequestThumbnailInput,
  ): Promise<boolean> {
    if (!input.fileId || !this.blobService || !this.driver || !this.blobRepo) {
      return false;
    }

    const blob = await this.blobRepo.findById(input.fileId);
    if (!blob) {
      return false;
    }

    const derivKey = StorageKey.forDerivative(
      blob.contentHashHex,
      'thumb',
    ).value();
    const alreadyExists = await this.driver
      .exists(derivKey)
      .catch(() => false);
    if (alreadyExists) {
      return true;
    }

    if (input.kind === 'pdf' && blob.sizeBytes > MAX_PDF_THUMBNAIL_BYTES) {
      return false;
    }

    return this.runCoalesced(derivKey, async () => {
      const { stream } = await this.blobService!.openStream(input.fileId);
      const buf = await streamToBuffer(stream as AsyncIterable<Buffer>);

      if (input.kind === 'pdf') {
        const thumbBuffer = await this.generateThumbnail(buf, {
          width: input.width,
          height: input.height,
          quality: input.quality,
        });
        if (!thumbBuffer) return false;
        await this.driver!.put(derivKey, thumbBuffer, {
          mimeType: 'image/webp',
          size: thumbBuffer.length,
        });
        return true;
      }

      const result = await this.generateImageThumbnail(buf, {
        width: input.width,
        height: input.height,
        quality: input.quality,
      });
      if (!result) return false;
      await this.driver!.put(derivKey, result.buffer, {
        mimeType: result.mimeType,
        size: result.buffer.length,
      });
      return true;
    });
  }

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
