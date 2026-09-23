/**
 * filestore/core/ports/content-hasher.port.ts
 * Outbound Port (SPI) for streaming cryptographic and Git-blob Content-Addressable Storage (CAS) hashing.
 */

import { Readable } from 'node:stream';
import { ContentHash } from '../domain/value-objects/content-hash.vo';
import { StorageKey } from '../domain/value-objects/storage-key.vo';

export interface StreamHashResult {
  contentHash: ContentHash;
  sha256Hex: string;
  sizeBytes: number;
  /** A readable stream containing the original stream's bytes (since stream was consumed during hashing) */
  dataStream: Readable;
}

export abstract class IContentHasherPort {
  /**
   * Hashes a stream in a zero-buffering manner.
   * Caches incoming chunks or writes to a temporary spool file to return a replayable stream.
   */
  abstract hashStream(stream: Readable): Promise<StreamHashResult>;

  /**
   * Computes hash for an in-memory buffer.
   */
  abstract hashBuffer(buffer: Buffer): StreamHashResult;

  /**
   * Builds the partitioned key: e.g. blobs/ab/cd/ef...
   */
  abstract buildStorageKey(hash: ContentHash, prefix?: string): StorageKey;
}
