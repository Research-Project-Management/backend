import { FileScope } from '../value-objects/file-scope.vo';

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
  metadata?: Record<string, any>;
  authorId: string;
  trashedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * Domain Entity: StorageNode
 * Represents a logical file or directory within the user or project virtual filesystem.
 */
export class StorageNode {
  public readonly id: string;
  public readonly projectId: string | null;
  public readonly isFolder: boolean;
  public readonly authorId: string;
  public readonly createdAt: Date;

  private _parentId: string | null;
  private _name: string;
  private _size: bigint;
  private _mimeType: string;
  private _blobId: string | null;
  private _scope: FileScope;
  private _starred: boolean;
  private _metadata: Record<string, any>;
  private _trashedAt: Date | null;
  private _updatedAt: Date;

  constructor(props: StorageNodeProps) {
    this.id = props.id;
    this.projectId = props.projectId ?? null;
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
  get metadata(): Record<string, any> {
    return this._metadata;
  }
  get trashedAt(): Date | null {
    return this._trashedAt;
  }
  get updatedAt(): Date {
    return this._updatedAt;
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
}
