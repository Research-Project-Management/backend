import { Injectable, Logger } from '@nestjs/common';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  ListPartsCommand,
  PutBucketLifecycleConfigurationCommand,
  GetBucketLifecycleConfigurationCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  IStorageDriver,
  StorageObjectMetadata,
  CompletedPart,
  StorageLifecycleConfiguration,
} from '../../domain/ports/storage-driver.port';
import { Readable } from 'node:stream';

export interface S3DriverConfig {
  endpoint?: string;
  region: string;
  bucket: string;
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
  };
  forcePathStyle?: boolean;
}

@Injectable()
export class S3StorageDriver implements IStorageDriver {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly logger = new Logger(S3StorageDriver.name);

  constructor(config: S3DriverConfig) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: config.credentials,
      forcePathStyle: config.forcePathStyle ?? false,
    });
    this.logger.log(
      `S3StorageDriver initialized for bucket: ${this.bucket} (endpoint: ${config.endpoint ?? 'AWS standard'})`,
    );
  }

  public getClient(): S3Client {
    return this.client;
  }

  public getBucketName(): string {
    return this.bucket;
  }

  async put(
    key: string,
    data: Buffer | Readable,
    options?: { mimeType?: string; size?: number },
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: data,
        ContentType: options?.mimeType ?? 'application/octet-stream',
        ContentLength: options?.size,
      }),
    );
  }

  async getStream(
    key: string,
    range?: { start: number; end: number },
  ): Promise<{
    stream: Readable;
    contentLength: number;
    contentRange?: string;
  }> {
    const rangeHeader = range ? `bytes=${range.start}-${range.end}` : undefined;
    const res = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Range: rangeHeader,
      }),
    );

    return {
      stream: res.Body as Readable,
      contentLength: res.ContentLength ?? 0,
      contentRange: res.ContentRange,
    };
  }

  async stat(key: string): Promise<StorageObjectMetadata> {
    const res = await this.client.send(
      new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    );

    return {
      key,
      size: res.ContentLength ?? 0,
      mimeType: res.ContentType ?? 'application/octet-stream',
      eTag: res.ETag,
      lastModified: res.LastModified ?? new Date(),
    };
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    );
  }

  async deleteMany(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.client.send(
      new DeleteObjectsCommand({
        Bucket: this.bucket,
        Delete: {
          Objects: keys.map((k) => ({ Key: k })),
        },
      }),
    );
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.stat(key);
      return true;
    } catch (err: any) {
      if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
        return false;
      }
      throw err;
    }
  }

  async copy(sourceKey: string, destinationKey: string): Promise<void> {
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        CopySource: `${this.bucket}/${sourceKey}`,
        Key: destinationKey,
      }),
    );
  }

  async getPresignedUploadUrl(
    key: string,
    options: {
      mimeType: string;
      expiresInSeconds?: number;
      sizeBytes?: number;
    },
  ): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: options.mimeType,
      ContentLength: options.sizeBytes,
    });
    return getSignedUrl(this.client, command, {
      expiresIn: options.expiresInSeconds ?? 3600,
    });
  }

  async getPresignedDownloadUrl(
    key: string,
    options: { expiresInSeconds?: number; filename?: string },
  ): Promise<string> {
    const disposition = options.filename
      ? `attachment; filename="${encodeURIComponent(options.filename)}"`
      : undefined;
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ResponseContentDisposition: disposition,
    });
    return getSignedUrl(this.client, command, {
      expiresIn: options.expiresInSeconds ?? 3600,
    });
  }

  async initiateMultipartUpload(
    key: string,
    options: { mimeType: string },
  ): Promise<{ uploadId: string }> {
    const res = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: options.mimeType,
      }),
    );
    if (!res.UploadId) {
      throw new Error(`Failed to initiate S3 multipart upload for key: ${key}`);
    }
    return { uploadId: res.UploadId };
  }

  async getPresignedPartUploadUrl(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresInSeconds = 3600,
  ): Promise<string> {
    const command = new UploadPartCommand({
      Bucket: this.bucket,
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
    });
    return getSignedUrl(this.client, command, { expiresIn: expiresInSeconds });
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<{ location?: string; eTag?: string }> {
    const sortedParts = [...parts]
      .sort((a, b) => a.partNumber - b.partNumber)
      .map((p) => ({
        PartNumber: p.partNumber,
        ETag: (p.eTag || p.etag || '').replace(/"/g, ''),
      }));

    const res = await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: sortedParts },
      }),
    );
    return { location: res.Location, eTag: res.ETag };
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.client.send(
      new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  async listUploadedParts(
    key: string,
    uploadId: string,
  ): Promise<CompletedPart[]> {
    const res = await this.client.send(
      new ListPartsCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
    return (res.Parts ?? []).map((p) => ({
      partNumber: p.PartNumber!,
      eTag: p.ETag!,
      etag: p.ETag!,
    }));
  }

  async applyLifecycleRules(
    config?: StorageLifecycleConfiguration,
  ): Promise<void> {
    const rules = config?.rules || [
      {
        id: 'cleanup-temp-uploads',
        prefix: 'tmp/',
        status: 'Enabled',
        expirationDays: 1,
      },
      {
        id: 'abort-incomplete-multipart',
        prefix: '',
        status: 'Enabled',
        abortIncompleteMultipartUploadDays: 7,
      },
      {
        id: 'archive-cold-storage',
        prefix: 'archives/',
        status: 'Enabled',
        transitions: [
          { days: 90, storageClass: 'STANDARD_IA' },
          { days: 180, storageClass: 'GLACIER' },
        ],
      },
      {
        id: 'expire-old-backups',
        prefix: 'backups/',
        status: 'Enabled',
        expirationDays: 30,
      },
    ];

    const s3Rules = rules.map((r) => {
      const ruleDef: any = {
        ID: r.id,
        Status: r.status,
        Filter: r.prefix ? { Prefix: r.prefix } : {},
      };
      if (r.expirationDays !== undefined) {
        ruleDef.Expiration = { Days: r.expirationDays };
      }
      if (r.abortIncompleteMultipartUploadDays !== undefined) {
        ruleDef.AbortIncompleteMultipartUpload = {
          DaysAfterInitiation: r.abortIncompleteMultipartUploadDays,
        };
      }
      if (r.transitions && r.transitions.length > 0) {
        ruleDef.Transitions = r.transitions.map((t) => ({
          Days: t.days,
          StorageClass: t.storageClass,
        }));
      }
      return ruleDef;
    });

    try {
      await this.client.send(
        new PutBucketLifecycleConfigurationCommand({
          Bucket: this.bucket,
          LifecycleConfiguration: {
            Rules: s3Rules,
          },
        }),
      );
      this.logger.log(
        `Bucket lifecycle configuration applied to ${this.bucket} (${s3Rules.length} rules)`,
      );
    } catch (err: any) {
      this.logger.warn(
        `Failed to apply bucket lifecycle configuration on ${this.bucket}: ${err?.message}`,
      );
    }
  }

  async getLifecycleRules(): Promise<StorageLifecycleConfiguration | null> {
    try {
      const res = await this.client.send(
        new GetBucketLifecycleConfigurationCommand({
          Bucket: this.bucket,
        }),
      );
      if (!res.Rules) return null;
      return {
        rules: res.Rules.map((r) => ({
          id: r.ID || 'unnamed-rule',
          prefix: r.Filter?.Prefix || '',
          status: (r.Status as any) || 'Enabled',
          expirationDays: r.Expiration?.Days,
          abortIncompleteMultipartUploadDays:
            r.AbortIncompleteMultipartUpload?.DaysAfterInitiation,
          transitions: r.Transitions?.map((t) => ({
            days: t.Days ?? 0,
            storageClass: (t.StorageClass as any) || 'STANDARD_IA',
          })),
        })),
      };
    } catch {
      return null;
    }
  }
}
