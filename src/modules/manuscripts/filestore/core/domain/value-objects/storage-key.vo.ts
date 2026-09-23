/**
 * filestore/core/domain/value-objects/storage-key.vo.ts
 * Value Object for Partitioned Object Storage Keys.
 * Pattern: blobs/${hash[0..1]}/${hash[2..3]}/${hash[4..]}
 * Prevents S3 partition prefix rate-limiting and Linux directory inode saturation.
 */

import { ContentHash } from './content-hash.vo';

export class StorageKey {
  private readonly _key: string;

  private constructor(key: string) {
    this._key = key;
  }

  public static fromHash(hash: ContentHash, prefix = 'blobs'): StorageKey {
    const rawHash = hash.getValue();
    const l1 = rawHash.slice(0, 2);
    const l2 = rawHash.slice(2, 4);
    const rest = rawHash.slice(4);
    return new StorageKey(`${prefix}/${l1}/${l2}/${rest}`);
  }

  public static fromRawKey(rawKey: string): StorageKey {
    if (!rawKey || typeof rawKey !== 'string' || rawKey.trim().length === 0) {
      throw new Error('Storage key cannot be empty.');
    }
    // Prevent directory traversal
    if (rawKey.includes('..') || rawKey.startsWith('/')) {
      throw new Error(`Insecure storage key: '${rawKey}'. Traversal sequences are prohibited.`);
    }
    return new StorageKey(rawKey.trim());
  }

  public getValue(): string {
    return this._key;
  }

  public toString(): string {
    return this._key;
  }
}
