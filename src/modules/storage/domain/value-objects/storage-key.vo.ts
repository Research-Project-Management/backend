import * as path from 'path';

/**
 * Value Object for deterministic, sanitized Storage Keys
 * Uses Content-Addressable Storage (CAS) hierarchy to prevent S3 partition hotspots.
 */
export class StorageKey {
  private readonly rawKey: string;

  private constructor(key: string) {
    this.rawKey = key;
  }

  /**
   * Generates a CAS key: blobs/{hash[0:2]}/{hash[2:4]}/{hash}
   * Example: blobs/e3/b0/e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
   * Yields 65,536 uniform prefixes for high-throughput S3/R2 sharding.
   */
  public static forBlob(sha256Hex: string): StorageKey {
    const cleanHex = sha256Hex.trim().toLowerCase();
    const p1 = cleanHex.slice(0, 2);
    const p2 = cleanHex.slice(2, 4);
    return new StorageKey(`blobs/${p1}/${p2}/${cleanHex}`);
  }

  /**
   * Generates a temporary multipart upload chunk key
   */
  public static forMultipartUpload(
    uploadSessionId: string,
    partNumber?: number,
  ): StorageKey {
    if (partNumber !== undefined) {
      return new StorageKey(
        `uploads/multipart/${uploadSessionId}/part-${partNumber}`,
      );
    }
    return new StorageKey(`uploads/multipart/${uploadSessionId}`);
  }

  public static fromString(key: string): StorageKey {
    // Sanitize: strip null bytes and path traversal sequences
    const sanitized = key.replace(/\0/g, '').replace(/(\.\.[/\\])+/g, '');
    return new StorageKey(sanitized);
  }

  public value(): string {
    return this.rawKey;
  }

  public toString(): string {
    return this.rawKey;
  }
}
