/**
 * filestore/core/domain/entities/manuscript-file.entity.ts
 * Domain Entity representing a Binary Asset in the Manuscripts Subsystem.
 */

import { ContentHash } from '../value-objects/content-hash.vo';
import { StorageKey } from '../value-objects/storage-key.vo';
import { StorageQuotaExceededException } from '../exceptions/storage-quota-exceeded.exception';

export const MAX_FILE_SIZE_BYTES = 1024 * 1024 * 1024; // 1 GB (Overleaf Parity)

export interface CreateManuscriptFileProps {
  id?: string;
  projectId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  hash: ContentHash;
  storageKey?: StorageKey;
  bucketName?: string;
  rev?: number;
  deleted?: boolean;
  deletedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export class ManuscriptFile {
  private readonly _id: string;
  private readonly _projectId: string;
  private _name: string;
  private _mimeType: string;
  private readonly _sizeBytes: number;
  private readonly _hash: ContentHash;
  private readonly _storageKey: StorageKey;
  private readonly _bucketName: string;
  private _rev: number;
  private _deleted: boolean;
  private _deletedAt: Date | null;
  private readonly _createdAt: Date;
  private _updatedAt: Date;

  private constructor(props: CreateManuscriptFileProps) {
    if (props.sizeBytes > MAX_FILE_SIZE_BYTES) {
      throw new StorageQuotaExceededException(props.sizeBytes, MAX_FILE_SIZE_BYTES);
    }

    this._id = props.id ?? crypto.randomUUID();
    this._projectId = props.projectId;
    this._name = ManuscriptFile.sanitizeFilename(props.name);
    this._mimeType = props.mimeType || 'application/octet-stream';
    this._sizeBytes = props.sizeBytes;
    this._hash = props.hash;
    this._storageKey = props.storageKey ?? StorageKey.fromHash(props.hash);
    this._bucketName = props.bucketName ?? 'manuscript-files';
    this._rev = props.rev ?? 0;
    this._deleted = props.deleted ?? false;
    this._deletedAt = props.deletedAt ?? null;
    this._createdAt = props.createdAt ?? new Date();
    this._updatedAt = props.updatedAt ?? new Date();
  }

  public static create(props: CreateManuscriptFileProps): ManuscriptFile {
    return new ManuscriptFile(props);
  }

  public static reconstitute(props: CreateManuscriptFileProps): ManuscriptFile {
    return new ManuscriptFile(props);
  }

  private static sanitizeFilename(raw: string): string {
    if (!raw || typeof raw !== 'string') {
      throw new Error('Filename must be a valid non-empty string.');
    }
    const trimmed = raw.trim();
    // Strip illegal path characters and path traversal
    const sanitized = trimmed.replace(/[/\\]/g, '_');
    if (sanitized.length === 0 || sanitized === '.' || sanitized === '..') {
      throw new Error(`Invalid filename: '${raw}'`);
    }
    return sanitized;
  }

  public get id(): string { return this._id; }
  public get projectId(): string { return this._projectId; }
  public get name(): string { return this._name; }
  public get mimeType(): string { return this._mimeType; }
  public get sizeBytes(): number { return this._sizeBytes; }
  public get hash(): ContentHash { return this._hash; }
  public get storageKey(): StorageKey { return this._storageKey; }
  public get bucketName(): string { return this._bucketName; }
  public get rev(): number { return this._rev; }
  public get deleted(): boolean { return this._deleted; }
  public get deletedAt(): Date | null { return this._deletedAt; }
  public get createdAt(): Date { return this._createdAt; }
  public get updatedAt(): Date { return this._updatedAt; }

  public rename(newName: string): void {
    this._name = ManuscriptFile.sanitizeFilename(newName);
    this._rev += 1;
    this._updatedAt = new Date();
  }

  public markDeleted(): void {
    this._deleted = true;
    this._deletedAt = new Date();
    this._updatedAt = new Date();
  }

  public restore(): void {
    this._deleted = false;
    this._deletedAt = null;
    this._updatedAt = new Date();
  }
}
