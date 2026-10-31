/**
 * filestore/adapters/filestore.adapters.ts
 * Driven Storage & Content-Hashing Adapters for Manuscripts Filestore:
 * - CryptoGitBlobHasherAdapter (Port: IContentHasherPort)
 * - LocalDiskBinaryStorageAdapter (Port: IBinaryStoragePort)
 * - S3BinaryStorageAdapter (Port: IBinaryStoragePort)
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable, PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
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
export class CryptoGitBlobHasherAdapter extends IContentHasherPort {
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

@Injectable()
export class S3BinaryStorageAdapter extends IBinaryStoragePort {
  private readonly logger = new Logger(S3BinaryStorageAdapter.name);
  private readonly s3Client: S3Client;
  private readonly defaultBucket: string;

  constructor(private readonly configService: ConfigService) {
    super();

    const region =
      this.configService.get<string>('AWS_REGION') ||
      this.configService.get<string>('S3_REGION') ||
      'us-east-1';
    const endpoint =
      this.configService.get<string>('AWS_ENDPOINT') ||
      this.configService.get<string>('S3_ENDPOINT') ||
      this.configService.get<string>('R2_API_URL');
    const accessKeyId =
      this.configService.get<string>('AWS_ACCESS_KEY_ID') ||
      this.configService.get<string>('R2_ACCESS_KEY') ||
      '';
    const secretAccessKey =
      this.configService.get<string>('AWS_SECRET_ACCESS_KEY') ||
      this.configService.get<string>('R2_SECRET_KEY') ||
      '';
    const rawForcePathStyle =
      this.configService.get<string | boolean>('AWS_S3_FORCE_PATH_STYLE') ??
      this.configService.get<string | boolean>('S3_FORCE_PATH_STYLE') ??
      true;
    const forcePathStyle =
      rawForcePathStyle === true || rawForcePathStyle === 'true';

    this.defaultBucket =
      this.configService.get<string>('AWS_S3_BUCKET') ||
      this.configService.get<string>('S3_BUCKET') ||
      this.configService.get<string>('R2_BUCKET_NAME') ||
      'manuscript-files';

    this.s3Client = new S3Client({
      region,
      endpoint: endpoint || undefined,
      forcePathStyle,
      credentials:
        accessKeyId && secretAccessKey
          ? {
              accessKeyId,
              secretAccessKey,
            }
          : undefined,
    });
  }

  private resolveTargetLocation(
    bucket: string,
    key: string,
  ): { Bucket: string; Key: string } {
    if (!bucket || bucket === 'manuscript-files') {
      return { Bucket: this.defaultBucket, Key: key };
    }
    if (
      bucket === 'flux-docstore-archive' &&
      this.defaultBucket !== 'flux-docstore-archive'
    ) {
      return {
        Bucket: this.defaultBucket,
        Key: key.startsWith('docstore-archive/')
          ? key
          : `docstore-archive/${key}`,
      };
    }
    return { Bucket: bucket, Key: key };
  }

  public async sendStream(
    bucket: string,
    key: string,
    stream: Readable,
    options?: StorageUploadOptions & { contentLength?: number },
  ): Promise<void> {
    let body: Readable | Buffer = stream;
    let contentLength = options?.contentLength;

    const fsPath = (stream as fs.ReadStream).path;
    if (contentLength === undefined && typeof fsPath === 'string') {
      try {
        const stat = await fs.promises.stat(fsPath);
        contentLength = stat.size;
      } catch {
        // Fallback
      }
    }

    if (contentLength === undefined) {
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      body = Buffer.concat(chunks);
      contentLength = body.length;
    }

    const target = this.resolveTargetLocation(bucket, key);
    const command = new PutObjectCommand({
      Bucket: target.Bucket,
      Key: target.Key,
      Body: body,
      ContentLength: contentLength,
      ContentType: options?.contentType || 'application/octet-stream',
      ContentEncoding: options?.contentEncoding,
    });

    await this.s3Client.send(command);
  }

  public async getObjectStream(
    bucket: string,
    key: string,
    range?: StorageRangeOptions,
  ): Promise<Readable> {
    let rangeHeader: string | undefined;
    if (range && range.start !== undefined && range.end !== undefined) {
      rangeHeader = `bytes=${range.start}-${range.end}`;
    }

    const target = this.resolveTargetLocation(bucket, key);
    const command = new GetObjectCommand({
      Bucket: target.Bucket,
      Key: target.Key,
      Range: rangeHeader,
    });

    const response = await this.s3Client.send(command);
    if (!response.Body) {
      throw new FilestoreValidationException(
        `Empty body returned from S3 for key '${key}'`,
      );
    }

    return response.Body as Readable;
  }

  public async getObjectMetadata(
    bucket: string,
    key: string,
  ): Promise<StorageObjectMetadata> {
    const target = this.resolveTargetLocation(bucket, key);
    const command = new HeadObjectCommand({
      Bucket: target.Bucket,
      Key: target.Key,
    });

    const response = await this.s3Client.send(command);
    return {
      sizeBytes: Number(response.ContentLength ?? 0),
      contentType: response.ContentType ?? 'application/octet-stream',
      etag: response.ETag,
      lastModified: response.LastModified ?? new Date(),
    };
  }

  public async getSignedDownloadUrl(
    bucket: string,
    key: string,
    expiresInSeconds: number,
  ): Promise<string | null> {
    const target = this.resolveTargetLocation(bucket, key);
    const command = new GetObjectCommand({
      Bucket: target.Bucket,
      Key: target.Key,
    });

    try {
      return await getSignedUrl(this.s3Client, command, {
        expiresIn: expiresInSeconds,
      });
    } catch (err) {
      this.logger.warn(
        `Failed to generate pre-signed URL for key '${key}': ${(err as Error).message}`,
      );
      return null;
    }
  }

  public async checkObjectExists(
    bucket: string,
    key: string,
  ): Promise<boolean> {
    try {
      await this.getObjectMetadata(bucket, key);
      return true;
    } catch (err) {
      const name = (err as Error).name;
      if (
        name === 'NotFound' ||
        name === 'NoSuchKey' ||
        (err as { $metadata?: { httpStatusCode?: number } }).$metadata
          ?.httpStatusCode === 404
      ) {
        return false;
      }
      throw err;
    }
  }

  public async deleteObject(bucket: string, key: string): Promise<void> {
    const target = this.resolveTargetLocation(bucket, key);
    const command = new DeleteObjectCommand({
      Bucket: target.Bucket,
      Key: target.Key,
    });
    await this.s3Client.send(command);
  }
}
