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

export function normalizeFileScope(
  scope: FileScope | string | null | undefined,
  hasProjectId = false,
): FileScope {
  if (!scope) {
    return hasProjectId ? FileScope.Project : FileScope.Personal;
  }
  const lower = String(scope).trim().toLowerCase();
  switch (lower) {
    case 'project':
      return FileScope.Project;
    case 'page':
      return FileScope.Page;
    case 'library':
      return FileScope.Library;
    case 'paper':
      return FileScope.Paper;
    case 'personal':
    default:
      return FileScope.Personal;
  }
}

export interface ListDriveFilter {
  userId?: string;
  parentId?: string | null;
  scope?: FileScope | string;
  projectId?: string | null;
  linkedToId?: string | null;
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

export interface StorageNodeAuthor {
  id: string;
  name?: string | null;
  email?: string | null;
  avatar?: string | null;
}

export interface StorageNodeProps {
  id: string;
  projectId?: string | null;
  linkedToId?: string | null;
  parentId?: string | null;
  name: string;
  isFolder: boolean;
  size: bigint;
  mimeType?: string;
  blobId?: string | null;
  scope?: FileScope | string;
  starred?: boolean;
  metadata?: Record<string, unknown>;
  authorId: string;
  author?: StorageNodeAuthor | null;
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
  public readonly author: StorageNodeAuthor | null;
  public readonly createdAt: Date;

  private _projectId: string | null;
  private _linkedToId: string | null;
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
    this.isFolder = props.isFolder;
    this.authorId = props.authorId;
    this.author = props.author ?? null;
    this.createdAt = props.createdAt ?? new Date();

    const resolvedScope = normalizeFileScope(
      props.scope,
      Boolean(props.projectId),
    );
    this._scope = resolvedScope;
    this._linkedToId = props.linkedToId ?? props.projectId ?? null;
    this._projectId =
      props.projectId ??
      (resolvedScope === FileScope.Project ? this._linkedToId : null);
    this._parentId = props.parentId ?? null;
    this._name = props.name;
    this._size = props.size;
    this._mimeType =
      props.mimeType ??
      (props.isFolder ? 'application/x-directory' : 'application/octet-stream');
    this._blobId = props.blobId ?? null;
    this._starred = props.starred ?? false;
    this._metadata = props.metadata ?? {};
    this._trashedAt = props.trashedAt ?? null;
    this._updatedAt = props.updatedAt ?? new Date();
  }

  get projectId(): string | null {
    return this._projectId;
  }

  get linkedToId(): string | null {
    return this._linkedToId;
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

  public toJSON(): Record<string, unknown> {
    return {
      id: this.id,
      projectId: this._projectId,
      linkedToId: this._linkedToId,
      parentId: this._parentId,
      name: this._name,
      isFolder: this.isFolder,
      size: this._size.toString(),
      mimeType: this._mimeType,
      blobId: this._blobId,
      scope: this._scope,
      starred: this._starred,
      metadata: this._metadata,
      authorId: this.authorId,
      author: this.author,
      trashedAt: this._trashedAt ? this._trashedAt.toISOString() : null,
      createdAt: this.createdAt.toISOString(),
      updatedAt: this._updatedAt.toISOString(),
    };
  }

  public static fromSerialized(raw: unknown): StorageNode {
    if (raw instanceof StorageNode) return raw;
    const obj = (raw || {}) as Record<string, unknown>;
    const rawSize = obj.size ?? obj._size ?? 0;
    const size =
      typeof rawSize === 'bigint'
        ? rawSize
        : BigInt(String(rawSize || '0'));
    const rawTrashedAt = obj.trashedAt ?? obj._trashedAt;
    const rawCreatedAt = obj.createdAt;
    const rawUpdatedAt = obj.updatedAt ?? obj._updatedAt;

    return new StorageNode({
      id: String(obj.id || ''),
      projectId: (obj.projectId ?? obj._projectId ?? null) as string | null,
      linkedToId: (obj.linkedToId ?? obj._linkedToId ?? null) as string | null,
      parentId: (obj.parentId ?? obj._parentId ?? null) as string | null,
      name: String(obj.name ?? obj._name ?? ''),
      isFolder: Boolean(obj.isFolder),
      size,
      mimeType: (obj.mimeType ?? obj._mimeType) as string | undefined,
      blobId: (obj.blobId ?? obj._blobId ?? null) as string | null,
      scope: (obj.scope ?? obj._scope) as FileScope | string | undefined,
      starred: Boolean(obj.starred ?? obj._starred ?? false),
      metadata: ((obj.metadata ?? obj._metadata) as Record<string, unknown>) || {},
      authorId: String(obj.authorId || ''),
      author: (obj.author as StorageNodeAuthor | null) ?? null,
      trashedAt: rawTrashedAt ? new Date(String(rawTrashedAt)) : null,
      createdAt: rawCreatedAt ? new Date(String(rawCreatedAt)) : new Date(),
      updatedAt: rawUpdatedAt ? new Date(String(rawUpdatedAt)) : new Date(),
    });
  }

  public setScope(
    scope: FileScope | string,
    linkedToId?: string | null,
  ): void {
    const normalized = normalizeFileScope(scope, Boolean(linkedToId));
    this._scope = normalized;
    this._linkedToId = linkedToId ?? null;
    if (normalized === FileScope.Project) {
      this._projectId = linkedToId ?? null;
    }
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

  public isTrashed(): boolean {
    return this._trashedAt !== null;
  }

  public toggleStar(): boolean {
    this._starred = !this._starred;
    this._updatedAt = new Date();
    return this._starred;
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

  /**
   * Sorts a flat list of StorageNodes bottom-up (files first, then deepest child folders before parents)
   * so subtrees can be safely deleted without violating foreign key constraints.
   */
  public static sortBottomUp(nodes: StorageNode[]): StorageNode[] {
    const idMap = new Map<string, StorageNode>(nodes.map((n) => [n.id, n]));
    const depthCache = new Map<string, number>();

    const getDepth = (node: StorageNode): number => {
      const cached = depthCache.get(node.id);
      if (cached !== undefined) return cached;

      let depth = 0;
      let curr: StorageNode | undefined = node;
      while (curr?.parentId && idMap.has(curr.parentId)) {
        depth++;
        curr = idMap.get(curr.parentId);
        if (depth > 100) break; // cycle guard
      }
      depthCache.set(node.id, depth);
      return depth;
    };

    return [...nodes].sort((a, b) => {
      if (!a.isFolder && b.isFolder) return -1;
      if (a.isFolder && !b.isFolder) return 1;
      return getDepth(b) - getDepth(a);
    });
  }
}

// ============================================================================
// STORAGE QUOTA MODEL
// ============================================================================

export const DEFAULT_STORAGE_QUOTA_BYTES = 5n * 1024n * 1024n * 1024n; // 5 GB

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
}

// ============================================================================
// DRIVE EVENTS
// ============================================================================

export class FileTrashedEvent {
  constructor(
    public readonly fileId: string,
    public readonly authorId: string,
    public readonly trashedAt: Date,
    public readonly projectId?: string | null,
  ) {}
}
