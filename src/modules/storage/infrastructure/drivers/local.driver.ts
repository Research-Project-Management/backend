import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'node:stream';
import {
  IStorageDriver,
  StorageObjectMetadata,
  CompletedPart,
} from '../../domain/ports/storage-driver.port';

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

  private resolveFilePath(key: string): string {
    const cleanKey = key.replace(/\0/g, '').replace(/(\.\.[\/\\])+/g, '');
    const fullPath = path.join(this.rootPath, cleanKey);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return fullPath;
  }

  async put(key: string, data: Buffer | Readable): Promise<void> {
    const fullPath = this.resolveFilePath(key);
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

  async exists(key: string): Promise<boolean> {
    const fullPath = this.resolveFilePath(key);
    return fs.existsSync(fullPath);
  }

  async copy(sourceKey: string, destinationKey: string): Promise<void> {
    const src = this.resolveFilePath(sourceKey);
    const dst = this.resolveFilePath(destinationKey);
    await fs.promises.copyFile(src, dst);
  }

  async getPresignedUploadUrl(key: string): Promise<string> {
    // Local driver fallback URL
    return `/api/files/local-upload?key=${encodeURIComponent(key)}`;
  }

  async getPresignedDownloadUrl(key: string): Promise<string> {
    return `/api/files/local-download?key=${encodeURIComponent(key)}`;
  }

  async initiateMultipartUpload(key: string): Promise<{ uploadId: string }> {
    return { uploadId: `local-mpu-${Date.now()}` };
  }

  async getPresignedPartUploadUrl(
    key: string,
    uploadId: string,
    partNumber: number,
  ): Promise<string> {
    return `/api/files/local-upload-part?key=${encodeURIComponent(key)}&uploadId=${uploadId}&part=${partNumber}`;
  }

  async completeMultipartUpload(): Promise<{
    location?: string;
    eTag?: string;
  }> {
    return { eTag: 'local-completed-etag' };
  }

  async abortMultipartUpload(): Promise<void> {}

  async listUploadedParts(): Promise<CompletedPart[]> {
    return [];
  }
}
