/**
 * filestore/filestore.types.ts
 * Types, Models, Value Objects, Exceptions, and Port contracts for Manuscripts Filestore.
 */

import { Readable } from 'node:stream';

export const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB (Overleaf Parity)

// ============================================================================
// EXCEPTIONS
// ============================================================================

export class FileNotFoundException extends Error {
  constructor(
    public readonly fileId: string,
    public readonly projectId?: string,
  ) {
    super(
      `Manuscript file '${fileId}' was not found in project '${projectId ?? 'unknown'}'.`,
    );
    this.name = 'FileNotFoundException';
  }
}

export class InvalidByteRangeException extends Error {
  constructor(
    public readonly rangeHeader: string,
    public readonly totalSizeBytes: number,
    message?: string,
  ) {
    super(
      message ??
        `Requested byte range '${rangeHeader}' is unsatisfiable for object of size ${totalSizeBytes} bytes (RFC 7233).`,
    );
    this.name = 'InvalidByteRangeException';
  }
}

export class DuplicateFileException extends Error {
  constructor(
    public readonly filename: string,
    public readonly projectId: string,
  ) {
    super(
      `A file with name '${filename}' already exists in project '${projectId}'.`,
    );
    this.name = 'DuplicateFileException';
  }
}

export class StorageQuotaExceededException extends Error {
  constructor(
    public readonly attemptedSizeBytes: number,
    public readonly maxAllowedSizeBytes: number,
  ) {
    super(
      `File size (${attemptedSizeBytes} bytes) exceeds maximum permissible storage limit (${maxAllowedSizeBytes} bytes).`,
    );
    this.name = 'StorageQuotaExceededException';
  }
}

export class FilestoreValidationException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FilestoreValidationException';
  }
}

// ============================================================================
// VALUE OBJECTS & MODELS
// ============================================================================

export class ContentHash {
  private readonly _value: string;

  private constructor(value: string) {
    this._value = value.toLowerCase().trim();
  }

  public static create(hash: string): ContentHash {
    if (!hash || typeof hash !== 'string') {
      throw new FilestoreValidationException(
        'Content hash must be a non-empty string.',
      );
    }

    const trimmed = hash.trim().toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(trimmed) && !/^[0-9a-f]{64}$/.test(trimmed)) {
      throw new FilestoreValidationException(
        `Invalid content hash format: '${hash}'. Expected 40-char or 64-char hex string.`,
      );
    }

    return new ContentHash(trimmed);
  }

  public getValue(): string {
    return this._value;
  }

  public equals(other: ContentHash): boolean {
    return this._value === other._value;
  }

  public toString(): string {
    return this._value;
  }
}

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
      throw new FilestoreValidationException('Storage key cannot be empty.');
    }
    if (rawKey.includes('..') || rawKey.startsWith('/')) {
      throw new FilestoreValidationException(
        `Insecure storage key: '${rawKey}'. Traversal sequences are prohibited.`,
      );
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

export class ByteRange {
  public readonly start: number;
  public readonly end: number;
  public readonly totalSizeBytes: number;

  private constructor(start: number, end: number, totalSizeBytes: number) {
    this.start = start;
    this.end = end;
    this.totalSizeBytes = totalSizeBytes;
  }

  public static parse(
    rangeHeader: string | undefined | null,
    totalSizeBytes: number,
  ): ByteRange | null {
    if (
      !rangeHeader ||
      typeof rangeHeader !== 'string' ||
      !rangeHeader.trim()
    ) {
      return null;
    }

    const trimmed = rangeHeader.trim();
    if (!trimmed.startsWith('bytes=')) {
      throw new InvalidByteRangeException(
        rangeHeader,
        totalSizeBytes,
        'Range header must start with "bytes="',
      );
    }

    const rangePart = trimmed.slice(6).trim();
    if (rangePart.includes(',')) {
      const firstRange = rangePart.split(',')[0].trim();
      return ByteRange.parseSingleRange(
        firstRange,
        totalSizeBytes,
        rangeHeader,
      );
    }

    return ByteRange.parseSingleRange(rangePart, totalSizeBytes, rangeHeader);
  }

  private static parseSingleRange(
    rangeStr: string,
    totalSizeBytes: number,
    originalHeader: string,
  ): ByteRange {
    const parts = rangeStr.split('-');
    if (parts.length !== 2) {
      throw new InvalidByteRangeException(
        originalHeader,
        totalSizeBytes,
        'Invalid range format',
      );
    }

    let start: number;
    let end: number;

    const startStr = parts[0].trim();
    const endStr = parts[1].trim();

    if (startStr === '' && endStr === '') {
      throw new InvalidByteRangeException(
        originalHeader,
        totalSizeBytes,
        'Range cannot be empty',
      );
    }

    if (startStr === '') {
      const suffixLength = parseInt(endStr, 10);
      if (isNaN(suffixLength) || suffixLength <= 0) {
        throw new InvalidByteRangeException(
          originalHeader,
          totalSizeBytes,
          'Invalid suffix range length',
        );
      }
      start = Math.max(0, totalSizeBytes - suffixLength);
      end = totalSizeBytes - 1;
    } else if (endStr === '') {
      start = parseInt(startStr, 10);
      if (isNaN(start) || start < 0) {
        throw new InvalidByteRangeException(
          originalHeader,
          totalSizeBytes,
          'Invalid start byte',
        );
      }
      end = totalSizeBytes - 1;
    } else {
      start = parseInt(startStr, 10);
      end = parseInt(endStr, 10);
      if (isNaN(start) || isNaN(end) || start < 0 || end < 0) {
        throw new InvalidByteRangeException(
          originalHeader,
          totalSizeBytes,
          'Range offsets must be non-negative integers',
        );
      }
    }

    if (totalSizeBytes === 0) {
      throw new InvalidByteRangeException(
        originalHeader,
        totalSizeBytes,
        'Cannot request range on 0-byte file',
      );
    }

    if (start > end || start >= totalSizeBytes) {
      throw new InvalidByteRangeException(originalHeader, totalSizeBytes);
    }

    end = Math.min(end, totalSizeBytes - 1);

    return new ByteRange(start, end, totalSizeBytes);
  }

  public get contentLength(): number {
    return this.end - this.start + 1;
  }

  public toContentRangeHeader(): string {
    return `bytes ${this.start}-${this.end}/${this.totalSizeBytes}`;
  }
}

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
      throw new StorageQuotaExceededException(
        props.sizeBytes,
        MAX_FILE_SIZE_BYTES,
      );
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

  public static sanitizeFilename(raw: string): string {
    if (!raw || typeof raw !== 'string') {
      throw new FilestoreValidationException(
        'Filename must be a valid non-empty string.',
      );
    }
    const trimmed = raw.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (trimmed.length === 0 || trimmed === '.' || trimmed === '..') {
      throw new FilestoreValidationException(`Invalid filename: '${raw}'`);
    }
    // If path contains traversal segments ('..') or empty double-slashes, sanitize slashes to '_'
    const segments = trimmed.split('/');
    const hasTraversalOrInvalidSegment = segments.some(
      (seg) => !seg || seg === '.' || seg === '..' || seg.includes('\u0000') || seg.length > 255,
    );
    if (hasTraversalOrInvalidSegment) {
      const flat = trimmed.replace(/[/\\]/g, '_');
      if (flat.length === 0 || flat === '.' || flat === '..') {
        throw new FilestoreValidationException(`Invalid filename: '${raw}'`);
      }
      return flat;
    }
    return segments.join('/');
  }

  public get id(): string {
    return this._id;
  }
  public get projectId(): string {
    return this._projectId;
  }
  public get name(): string {
    return this._name;
  }
  public get mimeType(): string {
    return this._mimeType;
  }
  public get sizeBytes(): number {
    return this._sizeBytes;
  }
  public get hash(): ContentHash {
    return this._hash;
  }
  public get storageKey(): StorageKey {
    return this._storageKey;
  }
  public get bucketName(): string {
    return this._bucketName;
  }
  public get rev(): number {
    return this._rev;
  }
  public get deleted(): boolean {
    return this._deleted;
  }
  public get deletedAt(): Date | null {
    return this._deletedAt;
  }
  public get createdAt(): Date {
    return this._createdAt;
  }
  public get updatedAt(): Date {
    return this._updatedAt;
  }

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

// ============================================================================
// INTERFACES & PORT CONTRACTS
// ============================================================================

export interface StorageUploadOptions {
  contentType?: string;
  contentEncoding?: string;
  sourceMd5?: string;
  metadata?: Record<string, string>;
}

export interface StorageRangeOptions {
  start?: number;
  end?: number;
}

export interface StorageObjectMetadata {
  sizeBytes: number;
  contentType: string;
  etag?: string;
  lastModified: Date;
}

export interface StreamHashResult {
  contentHash: ContentHash;
  sha256Hex: string;
  sizeBytes: number;
  dataStream: Readable;
}

export interface StreamManuscriptFileOutput {
  file: ManuscriptFile;
  stream: Readable;
  byteRange: ByteRange | null;
  isPartialContent: boolean;
  contentLength: number;
}

export interface GetFileHeadOutput {
  file: ManuscriptFile;
  storageMetadata?: StorageObjectMetadata;
}

export abstract class IBinaryStoragePort {
  abstract sendStream(
    bucket: string,
    key: string,
    stream: Readable,
    options?: StorageUploadOptions,
  ): Promise<void>;

  abstract getObjectStream(
    bucket: string,
    key: string,
    range?: StorageRangeOptions,
  ): Promise<Readable>;

  abstract getObjectMetadata(
    bucket: string,
    key: string,
  ): Promise<StorageObjectMetadata>;

  abstract getSignedDownloadUrl(
    bucket: string,
    key: string,
    expiresInSeconds: number,
  ): Promise<string | null>;

  abstract checkObjectExists(bucket: string, key: string): Promise<boolean>;

  abstract deleteObject(bucket: string, key: string): Promise<void>;
}

export abstract class IManuscriptFileRepository {
  abstract save(file: ManuscriptFile): Promise<ManuscriptFile>;
  abstract findById(id: string): Promise<ManuscriptFile | null>;
  abstract findByProjectAndId(
    projectId: string,
    id: string,
  ): Promise<ManuscriptFile | null>;
  abstract findByProjectAndName(
    projectId: string,
    name: string,
  ): Promise<ManuscriptFile | null>;
  abstract findByHash(hash: string): Promise<ManuscriptFile[]>;
  abstract listByProject(
    projectId: string,
    includeDeleted?: boolean,
  ): Promise<ManuscriptFile[]>;
  abstract delete(id: string): Promise<void>;
  abstract countReferencesByHash(hash: string): Promise<number>;
}

export abstract class IContentHasherPort {
  abstract hashStream(stream: Readable): Promise<StreamHashResult>;
  abstract hashBuffer(buffer: Buffer): StreamHashResult;
  abstract buildStorageKey(hash: ContentHash, prefix?: string): StorageKey;
}
