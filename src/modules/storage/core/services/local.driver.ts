import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'node:stream';
import {
  IStorageDriver,
  StorageObjectMetadata,
  CompletedPart,
  StorageLifecycleConfiguration,
} from '@/modules/storage/core';

@Injectable()
export class LocalStorageDriver implements IStorageDriver {
  private readonly rootPath: string;
  private readonly logger = new Logger(LocalStorageDriver.name);

  constructor(storagePath = './storage') {
    this.rootPath = path.resolve(process.cwd(), storagePath);
    if (!fs.existsSync(this.rootPath)) {
      fs.mkdirSync(this.rootPath, { recursive: true });
    }
    this.logger.log(`LocalStorageDriver initialized at: ${this.rootPath}`);
  }

  public resolveFilePath(key: string): string {
    const normalizedKey = key
      .replace(/\0/g, '')
      .replace(/\\/g, '/')
      .replace(/^\/+/, '');
    if (normalizedKey.includes('..')) {
      throw new BadRequestException(
        'Invalid storage key: Path traversal sequences (..) are strictly prohibited',
      );
    }
    const fullPath = path.resolve(this.rootPath, normalizedKey);
    if (
      fullPath !== this.rootPath &&
      !fullPath.startsWith(this.rootPath + path.sep)
    ) {
      throw new BadRequestException(
        'Access denied: Storage key escapes base storage directory',
      );
    }
    return fullPath;
  }

  async put(key: string, data: Buffer | Readable): Promise<void> {
    const fullPath = this.resolveFilePath(key);
    await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
    if (Buffer.isBuffer(data)) {
      await fs.promises.writeFile(fullPath, data);
    } else {
      const writeStream = fs.createWriteStream(fullPath);
      await new Promise<void>((resolve, reject) => {
        data.pipe(writeStream);
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
      });
    }
  }

  async getStream(
    key: string,
    range?: { start: number; end: number },
  ): Promise<{
    stream: Readable;
    contentLength: number;
    contentRange?: string;
  }> {
    const fullPath = this.resolveFilePath(key);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`File not found: ${key}`);
    }
    const stat = await fs.promises.stat(fullPath);
    const total = stat.size;

    if (range) {
      const stream = fs.createReadStream(fullPath, {
        start: range.start,
        end: range.end,
      });
      return {
        stream,
        contentLength: range.end - range.start + 1,
        contentRange: `bytes ${range.start}-${range.end}/${total}`,
      };
    }

    const stream = fs.createReadStream(fullPath);
    return { stream, contentLength: total };
  }

  async stat(key: string): Promise<StorageObjectMetadata> {
    const fullPath = this.resolveFilePath(key);
    const stat = await fs.promises.stat(fullPath);
    return {
      key,
      size: stat.size,
      mimeType: 'application/octet-stream',
      lastModified: stat.mtime,
    };
  }

  async delete(key: string): Promise<void> {
    const fullPath = this.resolveFilePath(key);
    if (fs.existsSync(fullPath)) {
      await fs.promises.unlink(fullPath);
    }
  }

  async deleteMany(keys: string[]): Promise<void> {
    for (const key of keys) {
      await this.delete(key);
    }
  }

  exists(key: string): Promise<boolean> {
    const fullPath = this.resolveFilePath(key);
    return Promise.resolve(fs.existsSync(fullPath));
  }

  async copy(sourceKey: string, destinationKey: string): Promise<void> {
    const src = this.resolveFilePath(sourceKey);
    const dst = this.resolveFilePath(destinationKey);
    await fs.promises.mkdir(path.dirname(dst), { recursive: true });
    await fs.promises.copyFile(src, dst);
  }

  getPresignedUploadUrl(key: string): Promise<string> {
    // Local driver fallback URL
    return Promise.resolve(
      `/api/v1/storage/files/local-upload?key=${encodeURIComponent(key)}`,
    );
  }

  getPresignedDownloadUrl(key: string): Promise<string> {
    return Promise.resolve(
      `/api/v1/storage/files/local-download?key=${encodeURIComponent(key)}`,
    );
  }

  initiateMultipartUpload(_key: string): Promise<{ uploadId: string }> {
    return Promise.resolve({ uploadId: `local-mpu-${Date.now()}` });
  }

  getPresignedPartUploadUrl(
    key: string,
    uploadId: string,
    partNumber: number,
  ): Promise<string> {
    return Promise.resolve(
      `/api/v1/storage/files/local-upload-part?key=${encodeURIComponent(key)}&uploadId=${uploadId}&part=${partNumber}`,
    );
  }

  completeMultipartUpload(): Promise<{
    location?: string;
    eTag?: string;
  }> {
    return Promise.resolve({ eTag: 'local-completed-etag' });
  }

  abortMultipartUpload(): Promise<void> {
    return Promise.resolve();
  }

  listUploadedParts(): Promise<CompletedPart[]> {
    return Promise.resolve([]);
  }

  private activeLifecycleConfig: StorageLifecycleConfiguration | null = null;

  applyLifecycleRules(config?: StorageLifecycleConfiguration): Promise<void> {
    this.activeLifecycleConfig = config || {
      rules: [
        {
          id: 'cleanup-temp-uploads',
          prefix: 'tmp/',
          status: 'Enabled',
          expirationDays: 1,
        },
        {
          id: 'expire-old-backups',
          prefix: 'backups/',
          status: 'Enabled',
          expirationDays: 30,
        },
      ],
    };
    this.logger.log(
      `LocalStorageDriver lifecycle rules configured: ${this.activeLifecycleConfig.rules.length} rules`,
    );
    return Promise.resolve();
  }

  getLifecycleRules(): Promise<StorageLifecycleConfiguration | null> {
    return Promise.resolve(this.activeLifecycleConfig);
  }
}
