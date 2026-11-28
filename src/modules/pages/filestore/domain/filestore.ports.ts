/**
 * modules/pages/filestore/domain/filestore.ports.ts
 * Driven port contract for Pages Filestore physical binary storage (Platform S3 vs Local Disk).
 */

import { Readable } from 'node:stream';
import type {
  StorageObjectMetadata,
  StorageRangeOptions,
  StorageUploadOptions,
} from '../types/filestore.types';

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
