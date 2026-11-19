export { DEFAULT_STORAGE_QUOTA_BYTES } from '../files.constant';

export interface StorageQuotaProps {
  id: string;
  spaceId: string;
  usedBytes: bigint;
  maxBytes: bigint;
  updatedAt?: Date;
}

/**
 * Enforces per-space (personal or project) storage limits.
 */
export class StorageQuota {
  public readonly id: string;
  public readonly spaceId: string;

  private _usedBytes: bigint;
  private _maxBytes: bigint;
  private _updatedAt: Date;

  constructor(props: StorageQuotaProps) {
    this.id = props.id;
    this.spaceId = props.spaceId;
    this._usedBytes = props.usedBytes;
    this._maxBytes = props.maxBytes;
    this._updatedAt = props.updatedAt ?? new Date();
  }

  get usedBytes(): bigint {
    return this._usedBytes;
  }
  get maxBytes(): bigint {
    return this._maxBytes;
  }
  get updatedAt(): Date {
    return this._updatedAt;
  }
}
