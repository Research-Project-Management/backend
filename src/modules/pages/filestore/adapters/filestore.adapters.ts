/**
 * filestore/adapters/filestore.adapters.ts
 * Driven Storage & Content-Hashing Adapters for Manuscripts Filestore:
 * - ContentHasherAdapter (Port: IContentHasherPort)
 * - PlatformBinaryStorageAdapter (Port: IBinaryStoragePort -> unified with @/modules/storage/core)
 * - LocalDiskBinaryStorageAdapter (Port: IBinaryStoragePort - standalone/test fallback adapter)
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable, PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { STORAGE_DRIVER } from '@/modules/storage/storage.tokens';
import { BlobService, IStorageDriver } from '@/modules/storage/core';
import {
  IBinaryStoragePort,
  IContentHasherPort,
  StorageObjectMetadata,
  StorageRangeOptions,
  StorageUploadOptions,
  StreamHashResult,
  ContentHash,
  StorageKey,
  FilestoreValidationException,
  MAX_FILE_SIZE_BYTES,
  StorageQuotaExceededException,
} from '../filestore.types';

@Injectable()
export class ContentHasherAdapter extends IContentHasherPort {
  public async hashStream(stream: Readable): Promise<StreamHashResult> {
    const tempDir = path.join(os.tmpdir(), 'flux-filestore-spool');
    await fs.promises.mkdir(tempDir, { recursive: true });
    const tempFilePath = path.join(
      tempDir,
      `spool-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
    );

    const writeStream = fs.createWriteStream(tempFilePath);
    let sizeBytes = 0;

    const meterStream = new PassThrough();
    meterStream.on('data', (chunk: Buffer | string) => {
      sizeBytes +=
        typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      if (sizeBytes > MAX_FILE_SIZE_BYTES) {
        meterStream.destroy(
          new StorageQuotaExceededException(sizeBytes, MAX_FILE_SIZE_BYTES),
        );
      }
    });

    let cleanedUp = false;
    const cleanupTempFile = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      fs.promises.unlink(tempFilePath).catch(() => {});
    };

    try {
      await pipeline(stream, meterStream, writeStream);

      const gitHeader = Buffer.from(`blob ${sizeBytes}\0`, 'utf8');
      const gitHashObj = createHash('sha1');
      gitHashObj.update(gitHeader);

      const sha256Obj = createHash('sha256');

      const readStreamForHashing = fs.createReadStream(tempFilePath);
      await new Promise<void>((resolve, reject) => {
        readStreamForHashing.on('data', (chunk: Buffer | string) => {
          gitHashObj.update(chunk);
          sha256Obj.update(chunk);
        });
        readStreamForHashing.on('end', () => resolve());
        readStreamForHashing.on('error', reject);
      });

      const gitBlobHash = gitHashObj.digest('hex');
      const sha256Hex = sha256Obj.digest('hex');

      const replayStream = fs.createReadStream(tempFilePath);
      replayStream.on('close', cleanupTempFile);
      replayStream.on('error', cleanupTempFile);

      return {
        contentHash: ContentHash.create(gitBlobHash),
        sha256Hex,
        sizeBytes,
        dataStream: replayStream,
      };
    } catch (err) {
      cleanupTempFile();
      throw err;
    }
  }

  public hashBuffer(buffer: Buffer): StreamHashResult {
    const sizeBytes = buffer.length;
    const gitHeader = Buffer.from(`blob ${sizeBytes}\0`, 'utf8');

    const gitHashObj = createHash('sha1');
    gitHashObj.update(gitHeader);
    gitHashObj.update(buffer);
    const gitBlobHash = gitHashObj.digest('hex');

    const sha256Obj = createHash('sha256');
    sha256Obj.update(buffer);
    const sha256Hex = sha256Obj.digest('hex');

    const dataStream = Readable.from(buffer);

    return {
      contentHash: ContentHash.create(gitBlobHash),
      sha256Hex,
      sizeBytes,
      dataStream,
    };
  }

  public buildStorageKey(hash: ContentHash, prefix = 'blobs'): StorageKey {
    return StorageKey.fromHash(hash, prefix);
  }
}

export { ContentHasherAdapter as CryptoGitBlobHasherAdapter };

/**
 * Unified Platform Binary Storage Adapter (Overleaf Filestore -> Flux StorageCoreModule bridge).
 * Delegates all physical object I/O for manuscript binary assets and cold-tier doc archives
 * to the platform-wide `@Global()` StorageCoreModule (`BlobService` / `IStorageDriver`),
 * eliminating duplicate S3Client instances and fragmented disk storage.
 */
@Injectable()
export class PlatformBinaryStorageAdapter extends IBinaryStoragePort {
  private readonly logger = new Logger(PlatformBinaryStorageAdapter.name);

  constructor(
    @Optional() private readonly blobService?: BlobService,
    @Optional()
    @Inject(STORAGE_DRIVER)
    private readonly storageDriver?: IStorageDriver,
  ) {
    super();
  }

  private get target(): BlobService | IStorageDriver {
    const resolved = this.blobService ?? this.storageDriver;
    if (!resolved) {
      throw new FilestoreValidationException(
        'PlatformBinaryStorageAdapter requires either BlobService or STORAGE_DRIVER from StorageCoreModule',
      );
    }
    return resolved;
  }

  /**
   * Normalizes and validates logical bucket + key into a safe physical storage key
   * while preventing directory traversal (`..`) or null-byte injection.
   */
  public resolveStorageKey(bucket: string, key: string): string {
    const rawBucket = (bucket || 'manuscript-files').trim();
    const rawKey = (key || '').trim();

    if (
      !rawKey ||
      rawBucket.includes('..') ||
      rawKey.includes('..') ||
      rawBucket.includes('\0') ||
      rawKey.includes('\0') ||
      rawKey.startsWith('/') ||
      rawKey.startsWith('\\')
    ) {
      throw new FilestoreValidationException(
        `Invalid storage path traversal attempt: bucket="${bucket}", key="${key}"`,
      );
    }

    const cleanKey = rawKey.replace(/\\/g, '/').replace(/^\/+/, '');
    if (cleanKey.split('/').some((seg) => seg === '..' || seg === '.')) {
      throw new FilestoreValidationException(
        `Invalid storage path traversal attempt: bucket="${bucket}", key="${key}"`,
      );
    }

    if (
      rawBucket === 'flux-docstore-archive' &&
      !cleanKey.startsWith('docstore-archive/')
    ) {
      return `docstore-archive/${cleanKey}`;
    }

    return cleanKey;
  }

  public async sendStream(
    bucket: string,
    key: string,
    stream: Readable,
    options?: StorageUploadOptions & { contentLength?: number },
  ): Promise<void> {
    const physicalKey = this.resolveStorageKey(bucket, key);
    let contentLength = options?.contentLength;

    const fsPath = (stream as fs.ReadStream).path;
    if (contentLength === undefined && typeof fsPath === 'string') {
      try {
        const stat = await fs.promises.stat(fsPath);
        contentLength = stat.size;
      } catch {
        // Ignore stat error on non-file streams
      }
    }

    await this.target.put(physicalKey, stream, {
      mimeType: options?.contentType || 'application/octet-stream',
      size: contentLength,
    });
  }

  public async getObjectStream(
    bucket: string,
    key: string,
    range?: StorageRangeOptions,
  ): Promise<Readable> {
    const physicalKey = this.resolveStorageKey(bucket, key);
    const normalizedRange =
      range && range.start !== undefined && range.end !== undefined
        ? { start: range.start, end: range.end }
        : undefined;

    try {
      const result = await this.target.getStream(physicalKey, normalizedRange);
      if (!result?.stream) {
        throw new FilestoreValidationException(
          `Empty stream returned from platform storage for key '${physicalKey}'`,
        );
      }
      return result.stream as Readable;
    } catch (err) {
      if (err instanceof FilestoreValidationException) {
        throw err;
      }
      throw new FilestoreValidationException(
        `Object not found in platform storage for key '${physicalKey}': ${(err as Error).message}`,
      );
    }
  }

  public async getObjectMetadata(
    bucket: string,
    key: string,
  ): Promise<StorageObjectMetadata> {
    const physicalKey = this.resolveStorageKey(bucket, key);
    const meta = await this.target.stat(physicalKey);
    return {
      sizeBytes: Number(meta.size ?? 0),
      contentType: meta.mimeType ?? 'application/octet-stream',
      etag: meta.eTag,
      lastModified: meta.lastModified ?? new Date(),
    };
  }

  public async getSignedDownloadUrl(
    bucket: string,
    key: string,
    expiresInSeconds: number,
  ): Promise<string | null> {
    const physicalKey = this.resolveStorageKey(bucket, key);
    try {
      const url = await this.target.getPresignedDownloadUrl(physicalKey, {
        expiresInSeconds,
      });
      if (!url || url.startsWith('/api/v1/storage/files/local-download')) {
        return null;
      }
      return url;
    } catch (err) {
      this.logger.warn(
        `Failed to generate pre-signed download URL via platform storage for '${physicalKey}': ${(err as Error).message}`,
      );
      return null;
    }
  }

  public async checkObjectExists(
    bucket: string,
    key: string,
  ): Promise<boolean> {
    const physicalKey = this.resolveStorageKey(bucket, key);
    return await this.target.exists(physicalKey);
  }

  public async deleteObject(bucket: string, key: string): Promise<void> {
    const physicalKey = this.resolveStorageKey(bucket, key);
    await this.target.delete(physicalKey);
  }
}

@Injectable()
export class LocalDiskBinaryStorageAdapter extends IBinaryStoragePort {
  private readonly logger = new Logger(LocalDiskBinaryStorageAdapter.name);
  private readonly baseDir: string;

  constructor(@Optional() baseDir?: string) {
    super();
    this.baseDir =
      baseDir ?? path.resolve(process.cwd(), '.tmp', 'storage', 'manuscripts');
  }

  private resolvePath(bucket: string, key: string): string {
    const resolved = path.resolve(this.baseDir, bucket, ...key.split('/'));
    const resolvedBase = path.resolve(this.baseDir);
    if (
      resolved !== resolvedBase &&
      !resolved.startsWith(resolvedBase + path.sep)
    ) {
      throw new FilestoreValidationException(
        `Invalid storage path traversal attempt: bucket="${bucket}", key="${key}"`,
      );
    }
    return resolved;
  }

  public async sendStream(
    bucket: string,
    key: string,
    stream: Readable,
    _options?: StorageUploadOptions,
  ): Promise<void> {
    const destPath = this.resolvePath(bucket, key);
    await fs.promises.mkdir(path.dirname(destPath), { recursive: true });

    const tempPath = `${destPath}~${Date.now()}`;
    const fileWriter = fs.createWriteStream(tempPath);

    try {
      await pipeline(stream, fileWriter);
      await fs.promises.rename(tempPath, destPath);
    } catch (err) {
      await fs.promises.unlink(tempPath).catch(() => {});
      throw err;
    }
  }

  public async getObjectStream(
    bucket: string,
    key: string,
    range?: StorageRangeOptions,
  ): Promise<Readable> {
    const filePath = this.resolvePath(bucket, key);
    try {
      await fs.promises.access(filePath, fs.constants.R_OK);
    } catch {
      throw new FilestoreValidationException(
        `File not found on local disk: ${filePath}`,
      );
    }

    if (range && range.start !== undefined && range.end !== undefined) {
      return fs.createReadStream(filePath, {
        start: range.start,
        end: range.end,
      });
    }

    return fs.createReadStream(filePath);
  }

  public async getObjectMetadata(
    bucket: string,
    key: string,
  ): Promise<StorageObjectMetadata> {
    const filePath = this.resolvePath(bucket, key);
    const stats = await fs.promises.stat(filePath);
    return {
      sizeBytes: Number(stats.size),
      contentType: 'application/octet-stream',
      lastModified: stats.mtime,
    };
  }

  public async getSignedDownloadUrl(
    _bucket: string,
    _key: string,
    _expiresInSeconds: number,
  ): Promise<string | null> {
    return null;
  }

  public async checkObjectExists(
    bucket: string,
    key: string,
  ): Promise<boolean> {
    const filePath = this.resolvePath(bucket, key);
    try {
      await fs.promises.access(filePath, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  public async deleteObject(bucket: string, key: string): Promise<void> {
    const filePath = this.resolvePath(bucket, key);
    try {
      await fs.promises.unlink(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }
  }
}
