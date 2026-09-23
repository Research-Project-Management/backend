/**
 * filestore/core/ports/binary-storage.port.ts
 * Outbound Port (SPI) for Physical Object Storage.
 */

import { Readable } from 'node:stream';

export interface StorageUploadOptions {
  contentType?: string;
  contentEncoding?: string;
  sourceMd5?: string;
  metadata?: Record<string, string>;
}

export interface StorageRangeOptions {
  start?: number; // Inclusive start byte
  end?: number;   // Inclusive end byte
}

export interface StorageObjectMetadata {
  sizeBytes: number;
  contentType: string;
  etag?: string;
  lastModified: Date;
}

export abstract class IBinaryStoragePort {
  abstract sendStream(
    bucket: string,
    key: string,
    stream: Readable,
    options?: StorageUploadOptions,
  ): Promise<void>;

  abstract getObjectStream(
    bucket: string,
    key: string,
    range?: StorageRangeOptions,
  ): Promise<Readable>;

  abstract getObjectMetadata(
    bucket: string,
    key: string,
  ): Promise<StorageObjectMetadata>;

  abstract getSignedDownloadUrl(
    bucket: string,
    key: string,
    expiresInSeconds: number,
  ): Promise<string | null>;

  abstract checkObjectExists(bucket: string, key: string): Promise<boolean>;

  abstract deleteObject(bucket: string, key: string): Promise<void>;
}
