import * as crypto from 'crypto';

// ============================================================================
// CONTENT HASH & STORAGE KEY (VALUE OBJECTS)
// ============================================================================

/**
 * Cryptographic Content Hash (SHA-256) for Content-Addressable Storage (CAS).
 */
export class ContentHash {
  private readonly rawBytes: Buffer;

  private constructor(bytes: Buffer) {
    if (bytes.length !== 32) {
      throw new Error(
        `Invalid SHA-256 hash byte length: expected 32 bytes, got ${bytes.length}`,
      );
    }
    this.rawBytes = Buffer.from(bytes);
  }

  public static fromBuffer(payload: Buffer): ContentHash {
    const hashBytes = crypto.createHash('sha256').update(payload).digest();
    return new ContentHash(hashBytes);
  }

  public static fromHex(hexString: string): ContentHash {
    const sanitized = hexString.trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(sanitized)) {
      throw new Error(`Invalid SHA-256 hex string: ${hexString}`);
    }
    return new ContentHash(Buffer.from(sanitized, 'hex'));
  }

  public static fromBytes(bytes: Buffer): ContentHash {
    return new ContentHash(bytes);
  }

  public toHex(): string {
    return this.rawBytes.toString('hex');
  }

  public toBytes(): Buffer {
    return Buffer.from(this.rawBytes);
  }

  public equals(other: ContentHash): boolean {
    return this.rawBytes.equals(other.rawBytes);
  }

  public toString(): string {
    return this.toHex();
  }
}

/**
 * Deterministic, sanitized Storage Keys using CAS hierarchy to prevent S3 partition hotspots.
 */
export class StorageKey {
  private readonly rawKey: string;

  private constructor(key: string) {
    this.rawKey = key;
  }

  public static forBlob(sha256Hex: string): StorageKey {
    const cleanHex = sha256Hex.trim().toLowerCase();
    const p1 = cleanHex.slice(0, 2);
    const p2 = cleanHex.slice(2, 4);
    return new StorageKey(`blobs/${p1}/${p2}/${cleanHex}`);
  }

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

// ============================================================================
// STORAGE BLOB MODEL & STATUS
// ============================================================================

export enum BlobStatus {
  PENDING = 'PENDING',
  READY = 'READY',
  DELETED = 'DELETED',
}

export interface StorageBlobProps {
  id: string;
  contentHash: ContentHash;
  hashAlgorithm?: string;
  sizeBytes: bigint;
  s3Key: StorageKey;
  s3Bucket: string;
  storageClass?: string;
  refCount?: number;
  status?: BlobStatus;
  createdAt?: Date;
  tombstoneAt?: Date | null;
}

/**
 * Immutable physical binary payload stored on S3/R2/Local with CAS reference counting.
 */
export class StorageBlob {
  public readonly id: string;
  public readonly contentHash: ContentHash;
  public readonly hashAlgorithm: string;
  public readonly sizeBytes: bigint;
  public readonly s3Key: StorageKey;
  public readonly s3Bucket: string;
  public readonly storageClass: string;
  public readonly createdAt: Date;

  private _refCount: number;
  private _status: BlobStatus;
  private _tombstoneAt: Date | null;

  constructor(props: StorageBlobProps) {
    this.id = props.id;
    this.contentHash = props.contentHash;
    this.hashAlgorithm = props.hashAlgorithm ?? 'SHA256';
    this.sizeBytes = props.sizeBytes;
    this.s3Key = props.s3Key;
    this.s3Bucket = props.s3Bucket;
    this.storageClass = props.storageClass ?? 'STANDARD';
    this.createdAt = props.createdAt ?? new Date();

    this._refCount = props.refCount ?? 1;
    this._status = props.status ?? BlobStatus.PENDING;
    this._tombstoneAt = props.tombstoneAt ?? null;
  }

  get refCount(): number {
    return this._refCount;
  }

  get status(): BlobStatus {
    return this._status;
  }

  get tombstoneAt(): Date | null {
    return this._tombstoneAt;
  }

  public incrementRef(): void {
    this._refCount += 1;
    if (this._status === BlobStatus.DELETED) {
      this._status = BlobStatus.READY;
      this._tombstoneAt = null;
    }
  }

  public decrementRef(gracePeriodHours = 48): boolean {
    this._refCount = Math.max(0, this._refCount - 1);
    if (this._refCount === 0) {
      this._status = BlobStatus.DELETED;
      this._tombstoneAt = new Date(Date.now() + gracePeriodHours * 3600 * 1000);
      return true;
    }
    return false;
  }

  public markReady(): void {
    this._status = BlobStatus.READY;
  }

  public isReady(): boolean {
    return this._status === BlobStatus.READY;
  }
}
