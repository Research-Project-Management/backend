import { Readable } from 'node:stream';
import { FileScope } from '@/modules/storage/drive';
import { CompletedPart } from '@/modules/storage/core';

export enum UploadSessionStatus {
  INITIALIZED = 'INITIALIZED',
  UPLOADING = 'UPLOADING',
  COMPLETED = 'COMPLETED',
  ABORTED = 'ABORTED',
  EXPIRED = 'EXPIRED',
}

export interface UploadSessionProps {
  id: string;
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
 * Tracks multipart upload lifecycle for large files (> 100MB).
 */
export class UploadSession {
  public readonly id: string;
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

  get status(): UploadSessionStatus {
    return this._status;
  }
  get updatedAt(): Date {
    return this._updatedAt;
  }

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

/**
 * RFC 7233 HTTP Byte Range ("bytes=0-1023", "bytes=500-", "bytes=-500").
 */
export class ByteRange {
  public readonly start: number;
  public readonly end: number;
  public readonly length: number;
  public readonly totalSize: number;

  private constructor(start: number, end: number, totalSize: number) {
    this.start = start;
    this.end = end;
    this.length = end - start + 1;
    this.totalSize = totalSize;
  }

  public static parse(
    rangeHeader: string | undefined,
    totalSize: number,
  ): ByteRange | null {
    if (!rangeHeader || totalSize <= 0) {
      return null;
    }

    const match = rangeHeader.trim().match(/^bytes=(\d*)-(\d*)$/);
    if (!match) {
      return null;
    }

    const [_, startStr, endStr] = match;
    let start: number | undefined = startStr
      ? parseInt(startStr, 10)
      : undefined;
    let end: number | undefined = endStr ? parseInt(endStr, 10) : undefined;

    if (start === undefined && end !== undefined) {
      start = Math.max(0, totalSize - end);
      end = totalSize - 1;
    } else if (start !== undefined && end === undefined) {
      end = totalSize - 1;
    } else if (start === undefined && end === undefined) {
      start = 0;
      end = totalSize - 1;
    }

    if (
      start === undefined ||
      end === undefined ||
      start < 0 ||
      start >= totalSize ||
      end < start ||
      end >= totalSize
    ) {
      return null;
    }

    return new ByteRange(start, end, totalSize);
  }

  public getContentRangeHeader(): string {
    return `bytes ${this.start}-${this.end}/${this.totalSize}`;
  }
}

export interface UploadDirectInput {
  userId: string;
  filename: string;
  buffer: Buffer;
  mimeType: string;
  projectId?: string | null;
  parentId?: string | null;
  scope?: FileScope;
  source?: string;
}

export interface UploadDirectOutput {
  fileId: string;
  blobId: string;
  url: string;
  filename: string;
  size: number;
  mimeType: string;
  isDeduplicated: boolean;
}

export interface PresignUploadInput {
  userId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  contentHash?: string;
  projectId?: string | null;
  parentId?: string | null;
  scope?: FileScope;
}

export interface PresignUploadOutput {
  uploadUrl: string;
  storageKey: string;
  fileUuid: string;
  expiresIn: number;
  deduplicated: boolean;
  fileId?: string;
  url?: string;
  filename?: string;
  size?: number;
  mimeType?: string;
}

export interface CompletePresignInput {
  userId: string;
  storageKey: string;
  filename: string;
  sizeBytes?: number;
  mimeType?: string;
  projectId?: string | null;
  parentId?: string | null;
  scope?: FileScope;
  source?: string;
  contentHash?: string;
}

export interface CompletePresignOutput {
  fileId: string;
  blobId: string;
  url: string;
  filename: string;
  size: number;
  mimeType: string;
  isDeduplicated?: boolean;
}

export interface StreamBinaryOutput {
  stream: Readable | null;
  statusCode: number;
  mimeType: string;
  contentLength: number;
  contentRange?: string;
  filename: string;
  etag?: string;
}

export interface MultipartActorContext {
  userId: string;
  projectId?: string | null;
}

export interface InitiateMultipartInput {
  userId: string;
  filename: string;
  mimeType: string;
  totalSize: number;
  projectId?: string | null;
  parentId?: string | null;
  scope?: FileScope;
  expectedHash?: string;
}

export interface CompleteMultipartInput {
  sessionId: string;
  parts: CompletedPart[];
  actor?: MultipartActorContext;
}

export interface CompleteMultipartOutput {
  fileId: string;
  blobId: string;
  filename: string;
  size: number;
  mimeType: string;
}
