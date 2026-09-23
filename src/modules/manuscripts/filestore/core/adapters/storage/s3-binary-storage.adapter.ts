/**
 * filestore/core/adapters/storage/s3-binary-storage.adapter.ts
 * Driven Adapter implementing IBinaryStoragePort for AWS S3, MinIO, Cloudflare R2, and Tigris.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'node:stream';
import {
  IBinaryStoragePort,
  StorageObjectMetadata,
  StorageRangeOptions,
  StorageUploadOptions,
} from '../../ports/binary-storage.port';

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
    const secretAccessKey = this.configService.get<string>('AWS_SECRET_ACCESS_KEY', '');
    const forcePathStyle = this.configService.get<boolean>('AWS_S3_FORCE_PATH_STYLE', true);

    this.defaultBucket = this.configService.get<string>('AWS_S3_BUCKET', 'manuscript-files');

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
    options?: StorageUploadOptions,
  ): Promise<void> {
    // Collect stream chunks for standard PutObject or pass stream directly
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks);

    const command = new PutObjectCommand({
      Bucket: bucket || this.defaultBucket,
      Key: key,
      Body: body,
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

  public async getObjectMetadata(bucket: string, key: string): Promise<StorageObjectMetadata> {
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
      return await getSignedUrl(this.s3Client, command, { expiresIn: expiresInSeconds });
    } catch (err) {
      this.logger.warn(`Failed to generate pre-signed URL for key '${key}': ${(err as Error).message}`);
      return null;
    }
  }

  public async checkObjectExists(bucket: string, key: string): Promise<boolean> {
    try {
      await this.getObjectMetadata(bucket, key);
      return true;
    } catch (err) {
      const name = (err as Error).name;
      if (name === 'NotFound' || name === 'NoSuchKey' || (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) {
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
