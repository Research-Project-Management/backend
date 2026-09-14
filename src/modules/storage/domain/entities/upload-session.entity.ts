import { FileScope } from '../value-objects/file-scope.vo';

export enum UploadSessionStatus {
  INITIALIZED = 'INITIALIZED',
  UPLOADING = 'UPLOADING',
  COMPLETED = 'COMPLETED',
  ABORTED = 'ABORTED',
  EXPIRED = 'EXPIRED',
}

export interface UploadSessionProps {
  id: string;
  tenantId: string;
  projectId?: string | null;
  userId: string;
  s3UploadId: string;
  s3Key: string;
  filename: string;
  mimeType: string;
  totalSize: bigint;
  partSize: number;
  totalParts: number;
  expectedHash?: Buffer | null;
  parentId?: string | null;
  scope?: FileScope;
  status?: UploadSessionStatus;
  expiresAt: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * Domain Entity: UploadSession
 * Tracks multipart upload lifecycle for large files (> 100MB).
 */
export class UploadSession {
  public readonly id: string;
  public readonly tenantId: string;
  public readonly projectId: string | null;
  public readonly userId: string;
  public readonly s3UploadId: string;
  public readonly s3Key: string;
  public readonly filename: string;
  public readonly mimeType: string;
  public readonly totalSize: bigint;
  public readonly partSize: number;
  public readonly totalParts: number;
  public readonly expectedHash: Buffer | null;
  public readonly parentId: string | null;
  public readonly scope: FileScope;
  public readonly expiresAt: Date;
  public readonly createdAt: Date;

  private _status: UploadSessionStatus;
  private _updatedAt: Date;

  constructor(props: UploadSessionProps) {
    this.id = props.id;
    this.tenantId = props.tenantId;
    this.projectId = props.projectId ?? null;
    this.userId = props.userId;
    this.s3UploadId = props.s3UploadId;
    this.s3Key = props.s3Key;
    this.filename = props.filename;
    this.mimeType = props.mimeType;
    this.totalSize = props.totalSize;
    this.partSize = props.partSize;
    this.totalParts = props.totalParts;
    this.expectedHash = props.expectedHash ?? null;
    this.parentId = props.parentId ?? null;
    this.scope = props.scope ?? FileScope.Personal;
    this.expiresAt = props.expiresAt;
    this.createdAt = props.createdAt ?? new Date();

    this._status = props.status ?? UploadSessionStatus.INITIALIZED;
    this._updatedAt = props.updatedAt ?? new Date();
  }

  get status(): UploadSessionStatus { return this._status; }
  get updatedAt(): Date { return this._updatedAt; }

  public markUploading(): void {
    if (this._status === UploadSessionStatus.INITIALIZED) {
      this._status = UploadSessionStatus.UPLOADING;
      this._updatedAt = new Date();
    }
  }

  public markCompleted(): void {
    this._status = UploadSessionStatus.COMPLETED;
    this._updatedAt = new Date();
  }

  public markAborted(): void {
    this._status = UploadSessionStatus.ABORTED;
    this._updatedAt = new Date();
  }

  public isExpired(): boolean {
    return new Date() > this.expiresAt;
  }
}
