/**
 * modules/pages/filestore/types/filestore.types.ts
 * IO data transfer interfaces for Pages Filestore operations.
 */

import { Readable } from 'node:stream';
import type { ByteRange, ContentHash, PageBinaryAsset } from '../domain/file.entity';

export interface StorageUploadOptions {
  contentType?: string;
  contentEncoding?: string;
  sourceMd5?: string;
  metadata?: Record<string, string>;
}

export interface StorageRangeOptions {
  start?: number;
  end?: number;
}

export interface StorageObjectMetadata {
  sizeBytes: number;
  contentType: string;
  etag?: string;
  lastModified: Date;
}

export interface StreamHashResult {
  contentHash: ContentHash;
  sha256Hex: string;
  sizeBytes: number;
  dataStream: Readable;
}

export interface StreamPageBinaryAssetOutput {
  file: PageBinaryAsset;
  stream: Readable;
  byteRange: ByteRange | null;
  isPartialContent: boolean;
  contentLength: number;
}

export interface GetFileHeadOutput {
  file: PageBinaryAsset;
  storageMetadata?: StorageObjectMetadata;
}
