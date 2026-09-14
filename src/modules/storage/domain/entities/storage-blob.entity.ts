import { ContentHash } from '../value-objects/content-hash.vo';
import { StorageKey } from '../value-objects/storage-key.vo';

export enum BlobStatus {
  PENDING = 'PENDING',
  READY = 'READY',
  DELETED = 'DELETED',
}

export interface StorageBlobProps {
  id: string;
  tenantId: string;
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
 * Domain Entity: StorageBlob
 * Represents the immutable physical binary payload stored on S3/R2/Local.
 * Implements Content-Addressable Storage (CAS) with reference counting.
 */
export class StorageBlob {
  public readonly id: string;
  public readonly tenantId: string;
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
    this.tenantId = props.tenantId;
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
      return true; // Eligible for garbage collection
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
