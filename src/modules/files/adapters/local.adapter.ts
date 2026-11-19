import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'node:stream';
import {
  IStorageAdapter,
  StorageObjectMetadata,
  CompletedPart,
  StorageLifecycleConfiguration,
} from '../types/adapter.type';
import { inferMimeType } from '../domain/files.policy';

@Injectable()
export class LocalStorageAdapter implements IStorageAdapter {
  private readonly rootPath: string;
  private readonly logger = new Logger(LocalStorageAdapter.name);

  constructor(storagePath = './storage') {
    this.rootPath = path.resolve(process.cwd(), storagePath);
    if (!fs.existsSync(this.rootPath)) {
      fs.mkdirSync(this.rootPath, { recursive: true });
    }
    this.logger.log(`LocalStorageAdapter initialized at: ${this.rootPath}`);
  }

  private getSigningSecret(): string {
    return (
      process.env.STORAGE_HMAC_SECRET ||
      process.env.JWT_SECRET ||
      'flux-local-storage-hmac-secret'
    );
  }

  public signToken(
    action: 'put' | 'part' | 'get',
    resource: string,
    expiresAt: number,
  ): string {
    return crypto
      .createHmac('sha256', this.getSigningSecret())
      .update(`${action}:${resource}:${expiresAt}`)
      .digest('hex');
  }

  public verifyToken(
    action: 'put' | 'part' | 'get',
    resource: string,
    expiresAt: number,
    sig: string,
  ): boolean {
    if (!sig || !Number.isFinite(expiresAt) || Date.now() > expiresAt) {
      return false;
    }
    const expected = this.signToken(action, resource, expiresAt);
    const sigBuf = Buffer.from(sig, 'utf8');
    const expBuf = Buffer.from(expected, 'utf8');
    if (sigBuf.length !== expBuf.length) {
      return false;
    }
    return crypto.timingSafeEqual(sigBuf, expBuf);
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

  private getMultipartDir(uploadId: string): string {
    const safeUploadId = uploadId.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safeUploadId) {
      throw new BadRequestException('Invalid multipart uploadId');
    }
    return this.resolveFilePath(`.multipart/${safeUploadId}`);
  }

  async put(key: string, data: Buffer | Readable): Promise<void> {
    const fullPath = this.resolveFilePath(key);
    await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
    if (Buffer.isBuffer(data)) {
      await fs.promises.writeFile(fullPath, data);
    } else {
      const writeStream = fs.createWriteStream(fullPath);
      await new Promise<void>((resolve, reject) => {
        data.on('error', reject);
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
        data.pipe(writeStream);
      });
    }
  }

  async putPart(
    uploadId: string,
    partNumber: number,
    data: Buffer | Readable,
  ): Promise<{ eTag: string }> {
    if (!Number.isInteger(partNumber) || partNumber < 1) {
      throw new BadRequestException('Invalid multipart partNumber');
    }
    const partDir = this.getMultipartDir(uploadId);
    await fs.promises.mkdir(partDir, { recursive: true });
    const partPath = path.join(partDir, `part.${partNumber}`);
    const hash = crypto.createHash('md5');

    if (Buffer.isBuffer(data)) {
      hash.update(data);
      await fs.promises.writeFile(partPath, data);
      return { eTag: hash.digest('hex') };
    }

    const writeStream = fs.createWriteStream(partPath);
    await new Promise<void>((resolve, reject) => {
      data.on('data', (chunk: Buffer | string) => {
        hash.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      data.on('error', reject);
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
      data.pipe(writeStream);
    });
    return { eTag: hash.digest('hex') };
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
      const effectiveEnd =
        total > 0 ? Math.min(range.end, total - 1) : range.end;
      const stream = fs.createReadStream(fullPath, {
        start: range.start,
        end: effectiveEnd,
      });
      return {
        stream,
        contentLength:
          total > 0 ? Math.max(0, effectiveEnd - range.start + 1) : 0,
        contentRange: `bytes ${range.start}-${effectiveEnd}/${total}`,
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
      mimeType: inferMimeType({ filename: key }),
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

  getPresignedUploadUrl(
    key: string,
    options?: {
      mimeType?: string;
      expiresInSeconds?: number;
      sizeBytes?: number;
    },
  ): Promise<string> {
    const expiresAt = Date.now() + (options?.expiresInSeconds ?? 3600) * 1000;
    const sig = this.signToken('put', key, expiresAt);
    return Promise.resolve(
      `/api/v1/files/local-upload?key=${encodeURIComponent(key)}&expires=${expiresAt}&sig=${sig}`,
    );
  }

  getPresignedDownloadUrl(
    key: string,
    options?: { expiresInSeconds?: number; filename?: string },
  ): Promise<string> {
    const expiresAt = Date.now() + (options?.expiresInSeconds ?? 3600) * 1000;
    const sig = this.signToken('get', key, expiresAt);
    const filenameParam = options?.filename
      ? `&filename=${encodeURIComponent(options.filename)}`
      : '';
    return Promise.resolve(
      `/api/v1/files/local-download?key=${encodeURIComponent(key)}&expires=${expiresAt}&sig=${sig}${filenameParam}`,
    );
  }

  initiateMultipartUpload(_key: string): Promise<{ uploadId: string }> {
    return Promise.resolve({
      uploadId: `local-mpu-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
    });
  }

  getPresignedPartUploadUrl(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresInSeconds = 3600,
  ): Promise<string> {
    const expiresAt = Date.now() + expiresInSeconds * 1000;
    const sig = this.signToken(
      'part',
      `${key}:${uploadId}:${partNumber}`,
      expiresAt,
    );
    return Promise.resolve(
      `/api/v1/files/local-upload-part?key=${encodeURIComponent(key)}&uploadId=${encodeURIComponent(uploadId)}&part=${partNumber}&expires=${expiresAt}&sig=${sig}`,
    );
  }

  async completeMultipartUpload(
    key: string,
    uploadId?: string,
    parts?: CompletedPart[],
  ): Promise<{
    location?: string;
    eTag?: string;
  }> {
    if (!uploadId) {
      return { eTag: 'local-completed-etag' };
    }

    const partDir = this.getMultipartDir(uploadId);
    if (!fs.existsSync(partDir)) {
      return { eTag: 'local-completed-etag' };
    }

    const fullPath = this.resolveFilePath(key);
    await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });

    const sortedParts = [...(parts || [])].sort(
      (a, b) => a.partNumber - b.partNumber,
    );

    const writeStream = fs.createWriteStream(fullPath);
    try {
      for (const part of sortedParts) {
        const partPath = path.join(partDir, `part.${part.partNumber}`);
        if (!fs.existsSync(partPath)) {
          throw new BadRequestException(
            `Missing uploaded multipart chunk ${part.partNumber}`,
          );
        }
        await new Promise<void>((resolve, reject) => {
          const readStream = fs.createReadStream(partPath);
          readStream.on('error', reject);
          writeStream.on('error', reject);
          readStream.on('end', resolve);
          readStream.pipe(writeStream, { end: false });
        });
      }
      await new Promise<void>((resolve, reject) => {
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
        writeStream.end();
      });
    } catch (err) {
      writeStream.destroy();
      throw err;
    }

    await fs.promises.rm(partDir, { recursive: true, force: true });
    return { eTag: 'local-completed-etag' };
  }

  async abortMultipartUpload(_key?: string, uploadId?: string): Promise<void> {
    if (!uploadId) return;
    const partDir = this.getMultipartDir(uploadId);
    await fs.promises.rm(partDir, { recursive: true, force: true });
  }

  listUploadedParts(): Promise<CompletedPart[]> {
    return Promise.resolve([]);
  }

  private activeLifecycleConfig: StorageLifecycleConfiguration | null = null;

  applyLifecycleRules(config?: StorageLifecycleConfiguration): Promise<void> {
    this.activeLifecycleConfig = config || {
      rules: [
        {
          id: 'cleanup-staging-uploads',
          prefix: 'uploads/staging/',
          status: 'Enabled',
          expirationDays: 1,
          abortIncompleteMultipartUploadDays: 1,
        },
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
      `LocalStorageAdapter lifecycle rules configured: ${this.activeLifecycleConfig.rules.length} rules`,
    );
    return Promise.resolve();
  }

  getLifecycleRules(): Promise<StorageLifecycleConfiguration | null> {
    return Promise.resolve(this.activeLifecycleConfig);
  }
}
