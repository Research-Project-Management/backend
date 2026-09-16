import { Readable } from 'node:stream';

export interface StorageObjectMetadata {
  key: string;
  size: number;
  mimeType: string;
  eTag?: string;
  lastModified: Date;
}

export interface CompletedPart {
  partNumber: number;
  eTag?: string;
  etag?: string;
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

/**
 * Port Interface: IStorageDriver
 * Abstraction for physical object storage providers (AWS S3, Cloudflare R2, MinIO, Local Disk).
 */
export interface IStorageDriver {
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
    },
  ): Promise<string>;
  getPresignedDownloadUrl(
    key: string,
    options: { expiresInSeconds?: number; filename?: string },
  ): Promise<string>;

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

  applyLifecycleRules?(
    config?: StorageLifecycleConfiguration,
  ): Promise<void>;
  getLifecycleRules?(): Promise<StorageLifecycleConfiguration | null>;
}
