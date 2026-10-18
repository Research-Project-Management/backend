/**
 * Scoping model for Storage Nodes in Flux
 */
export enum FileScope {
  Personal = 'Personal', // User personal drive file/folder
  Project = 'Project', // Shared research project workbench file
  Page = 'Page', // LaTeX / TipTap manuscript asset
  Library = 'Library', // Academic paper PDF / BibTeX attachment (hidden from personal drive)
  Paper = 'Paper', // Ingested research paper binary
}

export function isDriveVisible(
  scope: FileScope | string | null | undefined,
): boolean {
  if (!scope) return true;
  const strScope = String(scope);
  return (
    strScope !== (FileScope.Library as string) &&
    strScope !== (FileScope.Paper as string)
  );
}

export interface ListDriveFilter {
  userId?: string;
  parentId?: string | null;
  scope?: FileScope;
  projectId?: string | null;
  starredOnly?: boolean;
  trashedOnly?: boolean;
  authorId?: string;
  search?: string;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  types?: string[];
  limit?: number;
  offset?: number;
}

// ============================================================================
// STORAGE NODE MODEL
// ============================================================================

export interface StorageNodeProps {
  id: string;
  projectId?: string | null;
  parentId?: string | null;
  name: string;
  isFolder: boolean;
  size: bigint;
  mimeType?: string;
  blobId?: string | null;
  scope?: FileScope;
  starred?: boolean;
  metadata?: Record<string, unknown>;
  authorId: string;
  trashedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * Logical file or directory within the user or project virtual filesystem.
 */
export class StorageNode {
  public readonly id: string;
  public readonly isFolder: boolean;
  public readonly authorId: string;
  public readonly createdAt: Date;

  private _projectId: string | null;
  private _parentId: string | null;
  private _name: string;
  private _size: bigint;
  private _mimeType: string;
  private _blobId: string | null;
  private _scope: FileScope;
  private _starred: boolean;
  private _metadata: Record<string, unknown>;
  private _trashedAt: Date | null;
  private _updatedAt: Date;

  constructor(props: StorageNodeProps) {
    this.id = props.id;
    this._projectId = props.projectId ?? null;
    this.isFolder = props.isFolder;
    this.authorId = props.authorId;
    this.createdAt = props.createdAt ?? new Date();

    this._parentId = props.parentId ?? null;
    this._name = props.name;
    this._size = props.size;
    this._mimeType =
      props.mimeType ??
      (props.isFolder ? 'application/x-directory' : 'application/octet-stream');
    this._blobId = props.blobId ?? null;
    this._scope = props.scope ?? FileScope.Personal;
    this._starred = props.starred ?? false;
    this._metadata = props.metadata ?? {};
    this._trashedAt = props.trashedAt ?? null;
    this._updatedAt = props.updatedAt ?? new Date();
  }

  get projectId(): string | null {
    return this._projectId;
  }

  get parentId(): string | null {
    return this._parentId;
  }
  get name(): string {
    return this._name;
  }
  get size(): bigint {
    return this._size;
  }
  get mimeType(): string {
    return this._mimeType;
  }
  get blobId(): string | null {
    return this._blobId;
  }
  get scope(): FileScope {
    return this._scope;
  }
  get starred(): boolean {
    return this._starred;
  }
  get metadata(): Record<string, unknown> {
    return this._metadata;
  }
  get trashedAt(): Date | null {
    return this._trashedAt;
  }
  get updatedAt(): Date {
    return this._updatedAt;
  }

  public setScope(scope: FileScope, projectId?: string | null): void {
    this._scope = scope;
    this._projectId = projectId ?? null;
    this._updatedAt = new Date();
  }

  public rename(newName: string): void {
    const trimmed = newName.trim();
    if (!trimmed) throw new Error('File name cannot be empty');
    this._name = trimmed;
    this._updatedAt = new Date();
  }

  public moveTo(newParentId: string | null): void {
    if (newParentId === this.id) {
      throw new Error('A folder cannot be moved into itself');
    }
    this._parentId = newParentId;
    this._updatedAt = new Date();
  }

  public trash(): void {
    this._trashedAt = new Date();
    this._updatedAt = new Date();
  }

  public restore(): void {
    this._trashedAt = null;
    this._updatedAt = new Date();
  }

  public isTrashed(): boolean {
    return this._trashedAt !== null;
  }

  public toggleStar(): boolean {
    this._starred = !this._starred;
    this._updatedAt = new Date();
    return this._starred;
  }

  public updateSize(newSize: bigint): void {
    this._size = newSize;
    this._updatedAt = new Date();
  }

  public linkBlob(blobId: string, sizeBytes: bigint): void {
    this._blobId = blobId;
    this._size = sizeBytes;
    this._updatedAt = new Date();
  }

  public updateBlob(
    blobId: string,
    sizeBytes: bigint,
    mimeType?: string,
  ): void {
    this._blobId = blobId;
    this._size = sizeBytes;
    if (mimeType) {
      this._mimeType = mimeType;
    }
    this._updatedAt = new Date();
  }

  public updateMetadata(metadata: Record<string, unknown>): void {
    this._metadata = { ...this._metadata, ...metadata };
    this._updatedAt = new Date();
  }

  public toJSON() {
    return {
      id: this.id,
      name: this._name,
      filename: this._name,
      isFolder: this.isFolder,
      size: Number(this._size),
      mimeType: this._mimeType,
      parentId: this._parentId,
      parent: this._parentId,
      starred: this._starred,
      isStarred: this._starred,
      metadata: this._metadata,
      metaData: this._metadata,
      authorId: this.authorId,
      createdAt: this.createdAt,
      updatedAt: this._updatedAt,
      trashedAt: this._trashedAt,
    };
  }
}

// ============================================================================
// STORAGE QUOTA MODEL
// ============================================================================

export interface StorageQuotaProps {
  id: string;
  userId?: string | null;
  projectId?: string | null;
  usedBytes: bigint;
  maxBytes: bigint;
  updatedAt?: Date;
}

/**
 * Enforces per-user and per-project storage limits.
 */
export class StorageQuota {
  public readonly id: string;
  public readonly userId: string | null;
  public readonly projectId: string | null;

  private _usedBytes: bigint;
  private _maxBytes: bigint;
  private _updatedAt: Date;

  constructor(props: StorageQuotaProps) {
    this.id = props.id;
    this.userId = props.userId ?? null;
    this.projectId = props.projectId ?? null;
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

  public hasCapacity(requestedBytes: bigint): boolean {
    return this._usedBytes + requestedBytes <= this._maxBytes;
  }

  public consume(bytes: bigint): void {
    if (!this.hasCapacity(bytes)) {
      throw new Error(
        `Storage quota exceeded: requested ${bytes} bytes, available ${this._maxBytes - this._usedBytes} bytes`,
      );
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

// ============================================================================
// STORAGE VERSION MODEL
// ============================================================================

export interface StorageVersionAuthor {
  id: string;
  name?: string;
  avatar?: string | null;
  email?: string | null;
}

export interface StorageVersionProps {
  id: string;
  fileId: string;
  blobId: string;
  versionNumber: number;
  changeComment?: string | null;
  createdById: string;
  createdAt?: Date;
  sizeBytes?: bigint;
  mimeType?: string;
  author?: StorageVersionAuthor | null;
}

/**
 * Immutable historical revision snapshot of a logical file.
 */
export class StorageVersion {
  public readonly id: string;
  public readonly fileId: string;
  public readonly blobId: string;
  public readonly versionNumber: number;
  public readonly changeComment: string | null;
  public readonly createdById: string;
  public readonly createdAt: Date;
  public readonly sizeBytes: bigint;
  public readonly mimeType: string;
  public readonly author: StorageVersionAuthor | null;

  constructor(props: StorageVersionProps) {
    this.id = props.id;
    this.fileId = props.fileId;
    this.blobId = props.blobId;
    this.versionNumber = props.versionNumber;
    this.changeComment = props.changeComment ?? null;
    this.createdById = props.createdById;
    this.createdAt = props.createdAt ?? new Date();
    this.sizeBytes = props.sizeBytes ?? 0n;
    this.mimeType = props.mimeType ?? 'application/octet-stream';
    this.author = props.author ?? null;
  }

  isInitial(): boolean {
    return this.versionNumber === 1;
  }
}

// ============================================================================
// DRIVE EVENTS
// ============================================================================

export class FileDeletedEvent {
  constructor(
    public readonly fileId: string,
    public readonly blobId: string | null,
    public readonly authorId: string,
    public readonly projectId?: string | null,
    public readonly permanent = false,
  ) {}
}

export class FileTrashedEvent {
  constructor(
    public readonly fileId: string,
    public readonly authorId: string,
    public readonly trashedAt: Date,
    public readonly projectId?: string | null,
  ) {}
}

export class QuotaExceededEvent {
  constructor(
    public readonly userId: string | null,
    public readonly projectId: string | null,
    public readonly requestedBytes: bigint,
    public readonly currentUsedBytes: bigint,
    public readonly maxBytes: bigint,
  ) {}
}
