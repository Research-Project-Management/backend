export interface StorageQuotaProps {
  id: string;
  tenantId: string;
  projectId?: string | null;
  usedBytes: bigint;
  maxBytes: bigint;
  updatedAt?: Date;
}

/**
 * Domain Entity: StorageQuota
 * Enforces multi-tenant and per-project storage limits.
 */
export class StorageQuota {
  public readonly id: string;
  public readonly tenantId: string;
  public readonly projectId: string | null;

  private _usedBytes: bigint;
  private _maxBytes: bigint;
  private _updatedAt: Date;

  constructor(props: StorageQuotaProps) {
    this.id = props.id;
    this.tenantId = props.tenantId;
    this.projectId = props.projectId ?? null;
    this._usedBytes = props.usedBytes;
    this._maxBytes = props.maxBytes;
    this._updatedAt = props.updatedAt ?? new Date();
  }

  get usedBytes(): bigint { return this._usedBytes; }
  get maxBytes(): bigint { return this._maxBytes; }
  get updatedAt(): Date { return this._updatedAt; }

  public hasCapacity(requestedBytes: bigint): boolean {
    return this._usedBytes + requestedBytes <= this._maxBytes;
  }

  public consume(bytes: bigint): void {
    if (!this.hasCapacity(bytes)) {
      throw new Error(`Storage quota exceeded: requested ${bytes} bytes, available ${this._maxBytes - this._usedBytes} bytes`);
    }
    this._usedBytes += bytes;
    this._updatedAt = new Date();
  }

  public release(bytes: bigint): void {
    this._usedBytes = this._usedBytes > bytes ? this._usedBytes - bytes : 0n;
    this._updatedAt = new Date();
  }

  public getUsagePercentage(): number {
    if (this._maxBytes === 0n) return 100;
    return Number((this._usedBytes * 10000n) / this._maxBytes) / 100;
  }
}
