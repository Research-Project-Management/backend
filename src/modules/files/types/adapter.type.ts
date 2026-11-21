import { Readable } from 'node:stream';

export interface StorageObjectMetadata {
  key: string;
  size: number;
  mimeType: string;
  eTag?: string;
  checksumSha256?: string;
  lastModified: Date;
}

export interface CompletedPart {
  partNumber: number;
  eTag: string;
}

export interface StorageLifecycleRule {
  id: string;
  prefix?: string;
  status: 'Enabled' | 'Disabled';
  expirationDays?: number;
  abortIncompleteMultipartUploadDays?: number;
  transitions?: Array<{
    days: number;
    storageClass: 'STANDARD_IA' | 'GLACIER' | 'DEEP_ARCHIVE';
  }>;
}

export interface StorageLifecycleConfiguration {
  rules: StorageLifecycleRule[];
}

/** Core object CRUD + presigned read/write. */
export interface IObjectStorage {
  put(
    key: string,
    data: Buffer | Readable,
    options?: { mimeType?: string; size?: number },
  ): Promise<void>;
  getStream(
    key: string,
    range?: { start: number; end: number },
  ): Promise<{
    stream: Readable;
    contentLength: number;
    contentRange?: string;
  }>;
  stat(key: string): Promise<StorageObjectMetadata>;
  delete(key: string): Promise<void>;
  deleteMany(keys: string[]): Promise<void>;
  exists(key: string): Promise<boolean>;
  copy(sourceKey: string, destinationKey: string): Promise<void>;

  getPresignedUploadUrl(
    key: string,
    options: {
      mimeType: string;
      expiresInSeconds?: number;
      sizeBytes?: number;
      checksumSha256Base64?: string;
    },
  ): Promise<string>;
  getPresignedDownloadUrl(
    key: string,
    options: { expiresInSeconds?: number; filename?: string },
  ): Promise<string>;

  getBucketName?(): string;

  /**
   * True when clients can read objects directly from the storage provider via
   * presigned URLs (S3/R2). Enables 302 redirect offload by default.
   */
  readonly supportsDirectDownload?: boolean;
}

/** Resumable multipart upload capability. */
export interface IPresignMultipartStorage {
  initiateMultipartUpload(
    key: string,
    options: { mimeType: string },
  ): Promise<{ uploadId: string }>;
  getPresignedPartUploadUrl(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresInSeconds?: number,
  ): Promise<string>;
  completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<{ location?: string; eTag?: string }>;
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;
  listUploadedParts(key: string, uploadId: string): Promise<CompletedPart[]>;
}

/** Bucket lifecycle management; only providers with real server-side rules (S3/R2) implement it. */
export interface IBucketLifecycleDriver {
  applyLifecycleRules(config?: StorageLifecycleConfiguration): Promise<void>;
  getLifecycleRules(): Promise<StorageLifecycleConfiguration | null>;
}

/**
 * Abstraction for physical object storage providers (AWS S3, Cloudflare R2, MinIO, Local Disk).
 * Lifecycle management is an optional capability (see {@link supportsBucketLifecycle}).
 */
export interface IStorageAdapter
  extends
    IObjectStorage,
    IPresignMultipartStorage,
    Partial<IBucketLifecycleDriver> {}

export function supportsBucketLifecycle(
  adapter: unknown,
): adapter is IBucketLifecycleDriver {
  return (
    !!adapter &&
    typeof (adapter as Partial<IBucketLifecycleDriver>).applyLifecycleRules ===
      'function'
  );
}
