/**
 * filestore/filestore.repository.ts
 * Direct @Injectable() Repository for Manuscripts Filestore.
 *
 * Encapsulates:
 * - PostgreSQL metadata persistence via Prisma
 * - Physical binary storage seam (Local Disk vs S3/MinIO/R2/Tigris)
 * - Git-blob Content-Addressable Storage (CAS) stream hashing
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
import { ManuscriptFile as PrismaManuscriptFile } from '@prisma/client';
import { PrismaService } from '@/core';
import {
  IManuscriptFileRepository,
  IBinaryStoragePort,
  IContentHasherPort,
  StorageObjectMetadata,
  StorageRangeOptions,
  StorageUploadOptions,
  StreamHashResult,
  ManuscriptFile,
  ContentHash,
  StorageKey,
} from './filestore.types';

export class ManuscriptFileMapper {
  public static toDomain(row: PrismaManuscriptFile): ManuscriptFile {
    return ManuscriptFile.reconstitute({
      id: row.id,
      projectId: row.projectId,
      name: row.name,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      hash: ContentHash.create(row.hash),
      storageKey: StorageKey.fromRawKey(row.storageKey),
      bucketName: row.bucketName,
      rev: row.rev,
      deleted: row.deleted,
      deletedAt: row.deletedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  public static toPersistence(entity: ManuscriptFile): {
    id: string;
    projectId: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
    hash: string;
    storageKey: string;
    bucketName: string;
    rev: number;
    deleted: boolean;
    deletedAt: Date | null;
  } {
    return {
      id: entity.id,
      projectId: entity.projectId,
      name: entity.name,
      mimeType: entity.mimeType,
      sizeBytes: entity.sizeBytes,
      hash: entity.hash.getValue(),
      storageKey: entity.storageKey.getValue(),
      bucketName: entity.bucketName,
      rev: entity.rev,
      deleted: entity.deleted,
      deletedAt: entity.deletedAt,
    };
  }
}

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
    if (!resolved.startsWith(resolvedBase)) {
      throw new Error(
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
      throw new Error(`File not found on local disk: ${filePath}`);
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
    bucket: string,
    key: string,
    _expiresInSeconds: number,
  ): Promise<string | null> {
    return `/api/manuscripts/filestore/download/${bucket}/${key}`;
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

    const region = this.configService.get<string>('AWS_REGION', 'us-east-1');
    const endpoint = this.configService.get<string>('AWS_ENDPOINT');
    const accessKeyId = this.configService.get<string>('AWS_ACCESS_KEY_ID', '');
    const secretAccessKey = this.configService.get<string>(
      'AWS_SECRET_ACCESS_KEY',
      '',
    );
    const forcePathStyle = this.configService.get<boolean>(
      'AWS_S3_FORCE_PATH_STYLE',
      true,
    );

    this.defaultBucket = this.configService.get<string>(
      'AWS_S3_BUCKET',
      'manuscript-files',
    );

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

    const command = new PutObjectCommand({
      Bucket: bucket || this.defaultBucket,
      Key: key,
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

    const command = new GetObjectCommand({
      Bucket: bucket || this.defaultBucket,
      Key: key,
      Range: rangeHeader,
    });

    const response = await this.s3Client.send(command);
    if (!response.Body) {
      throw new Error(`Empty body returned from S3 for key '${key}'`);
    }

    return response.Body as Readable;
  }

  public async getObjectMetadata(
    bucket: string,
    key: string,
  ): Promise<StorageObjectMetadata> {
    const command = new HeadObjectCommand({
      Bucket: bucket || this.defaultBucket,
      Key: key,
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
    const command = new GetObjectCommand({
      Bucket: bucket || this.defaultBucket,
      Key: key,
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
    const command = new DeleteObjectCommand({
      Bucket: bucket || this.defaultBucket,
      Key: key,
    });
    await this.s3Client.send(command);
  }
}

@Injectable()
export class FilestoreRepository extends IManuscriptFileRepository {
  private readonly logger = new Logger(FilestoreRepository.name);
  private readonly storage: IBinaryStoragePort;
  private readonly hasher: CryptoGitBlobHasherAdapter;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() configService?: ConfigService,
    @Optional() storageOverride?: IBinaryStoragePort,
    @Optional() hasherOverride?: CryptoGitBlobHasherAdapter,
  ) {
    super();
    this.hasher = hasherOverride ?? new CryptoGitBlobHasherAdapter();
    if (storageOverride) {
      this.storage = storageOverride;
    } else if (configService) {
      const s3Key = configService.get<string>('AWS_ACCESS_KEY_ID');
      const s3Endpoint = configService.get<string>('AWS_ENDPOINT');
      const forceLocal =
        configService.get<string>('MANUSCRIPTS_FILESTORE_DRIVER') === 'local';

      this.storage =
        forceLocal || (!s3Key && !s3Endpoint)
          ? new LocalDiskBinaryStorageAdapter()
          : new S3BinaryStorageAdapter(configService);
    } else {
      this.storage = new LocalDiskBinaryStorageAdapter();
    }
  }

  public async hashStream(stream: Readable): Promise<StreamHashResult> {
    return this.hasher.hashStream(stream);
  }

  public hashBuffer(buffer: Buffer): StreamHashResult {
    return this.hasher.hashBuffer(buffer);
  }

  public buildStorageKey(hash: ContentHash, prefix = 'blobs'): StorageKey {
    return this.hasher.buildStorageKey(hash, prefix);
  }

  public async sendStream(
    bucket: string,
    key: string,
    stream: Readable,
    options?: StorageUploadOptions,
  ): Promise<void> {
    return this.storage.sendStream(bucket, key, stream, options);
  }

  public async getObjectStream(
    bucket: string,
    key: string,
    range?: StorageRangeOptions,
  ): Promise<Readable> {
    return this.storage.getObjectStream(bucket, key, range);
  }

  public async getObjectMetadata(
    bucket: string,
    key: string,
  ): Promise<StorageObjectMetadata> {
    return this.storage.getObjectMetadata(bucket, key);
  }

  public async getSignedDownloadUrl(
    bucket: string,
    key: string,
    expiresInSeconds: number,
  ): Promise<string | null> {
    return this.storage.getSignedDownloadUrl(bucket, key, expiresInSeconds);
  }

  public async checkObjectExists(
    bucket: string,
    key: string,
  ): Promise<boolean> {
    return this.storage.checkObjectExists(bucket, key);
  }

  public async deleteObject(bucket: string, key: string): Promise<void> {
    return this.storage.deleteObject(bucket, key);
  }

  public async save(file: ManuscriptFile): Promise<ManuscriptFile> {
    const data = ManuscriptFileMapper.toPersistence(file);

    const upserted = await this.prisma.manuscriptFile.upsert({
      where: { id: data.id },
      create: {
        id: data.id,
        projectId: data.projectId,
        name: data.name,
        mimeType: data.mimeType,
        sizeBytes: data.sizeBytes,
        hash: data.hash,
        storageKey: data.storageKey,
        bucketName: data.bucketName,
        rev: data.rev,
        deleted: data.deleted,
        deletedAt: data.deletedAt,
      },
      update: {
        name: data.name,
        mimeType: data.mimeType,
        sizeBytes: data.sizeBytes,
        hash: data.hash,
        storageKey: data.storageKey,
        bucketName: data.bucketName,
        rev: data.rev,
        deleted: data.deleted,
        deletedAt: data.deletedAt,
      },
    });

    return ManuscriptFileMapper.toDomain(upserted);
  }

  public async findById(id: string): Promise<ManuscriptFile | null> {
    const record = await this.prisma.manuscriptFile.findUnique({
      where: { id },
    });
    return record ? ManuscriptFileMapper.toDomain(record) : null;
  }

  public async findByProjectAndId(
    projectId: string,
    id: string,
  ): Promise<ManuscriptFile | null> {
    const record = await this.prisma.manuscriptFile.findFirst({
      where: {
        id,
        projectId,
      },
    });
    return record ? ManuscriptFileMapper.toDomain(record) : null;
  }

  public async findByProjectAndName(
    projectId: string,
    name: string,
  ): Promise<ManuscriptFile | null> {
    const record = await this.prisma.manuscriptFile.findFirst({
      where: {
        projectId,
        name,
        deleted: false,
      },
    });
    return record ? ManuscriptFileMapper.toDomain(record) : null;
  }

  public async findByHash(hash: string): Promise<ManuscriptFile[]> {
    const records = await this.prisma.manuscriptFile.findMany({
      where: {
        hash,
        deleted: false,
      },
    });
    return records.map(ManuscriptFileMapper.toDomain);
  }

  public async listByProject(
    projectId: string,
    includeDeleted = false,
  ): Promise<ManuscriptFile[]> {
    const records = await this.prisma.manuscriptFile.findMany({
      where: {
        projectId,
        ...(includeDeleted ? {} : { deleted: false }),
      },
      orderBy: { createdAt: 'desc' },
    });
    return records.map(ManuscriptFileMapper.toDomain);
  }

  public async delete(id: string): Promise<void> {
    await this.prisma.manuscriptFile.update({
      where: { id },
      data: {
        deleted: true,
        deletedAt: new Date(),
      },
    });
  }

  public async countReferencesByHash(hash: string): Promise<number> {
    return await this.prisma.manuscriptFile.count({
      where: {
        hash,
        deleted: false,
      },
    });
  }
}
