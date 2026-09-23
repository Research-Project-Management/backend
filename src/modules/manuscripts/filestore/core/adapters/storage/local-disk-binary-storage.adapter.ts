/**
 * filestore/core/adapters/storage/local-disk-binary-storage.adapter.ts
 * Driven Adapter implementing IBinaryStoragePort on local filesystem.
 * Provides atomic temp writes, byte-range streams, and zero external cloud dependencies.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  IBinaryStoragePort,
  StorageObjectMetadata,
  StorageRangeOptions,
  StorageUploadOptions,
} from '../../ports/binary-storage.port';

@Injectable()
export class LocalDiskBinaryStorageAdapter extends IBinaryStoragePort {
  private readonly logger = new Logger(LocalDiskBinaryStorageAdapter.name);
  private readonly baseDir: string;

  constructor(@Optional() baseDir?: string) {
    super();
    this.baseDir = baseDir ?? path.resolve(process.cwd(), '.tmp', 'storage', 'manuscripts');
  }

  private resolvePath(bucket: string, key: string): string {
    return path.join(this.baseDir, bucket, ...key.split('/'));
  }

  public async sendStream(
    bucket: string,
    key: string,
    stream: Readable,
    _options?: StorageUploadOptions,
  ): Promise<void> {
    const destPath = this.resolvePath(bucket, key);
    await fs.promises.mkdir(path.dirname(destPath), { recursive: true });

    // Atomic write pattern: stream to temp file first, then rename
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
      throw new Error(`File not found on local disk: ${filePath}`);
    }

    if (range && range.start !== undefined && range.end !== undefined) {
      return fs.createReadStream(filePath, { start: range.start, end: range.end });
    }

    return fs.createReadStream(filePath);
  }

  public async getObjectMetadata(bucket: string, key: string): Promise<StorageObjectMetadata> {
    const filePath = this.resolvePath(bucket, key);
    const stats = await fs.promises.stat(filePath);
    return {
      sizeBytes: Number(stats.size),
      contentType: 'application/octet-stream',
      lastModified: stats.mtime,
    };
  }

  public async getSignedDownloadUrl(
    bucket: string,
    key: string,
    _expiresInSeconds: number,
  ): Promise<string | null> {
    // For local development, signed URL resolves to local endpoint
    return `/api/manuscripts/filestore/download/${bucket}/${key}`;
  }

  public async checkObjectExists(bucket: string, key: string): Promise<boolean> {
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
