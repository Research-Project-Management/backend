/**
 * linked-files/core/domain/entities/linked-file.entity.ts
 * Domain entity representing an externally linked resource (Overleaf LinkedFiles parity).
 */

export type LinkedFileProvider = 'url' | 'zotero' | 'mendeley';
export type LinkedFileSyncStatus = 'synced' | 'failed' | 'pending';

export interface LinkedFileProps {
  id: string;
  projectId: string;
  name: string;
  provider: LinkedFileProvider;
  url?: string | null;
  collectionId?: string | null;
  nodeId?: string | null;
  docId?: string | null;
  fileId?: string | null;
  status: LinkedFileSyncStatus;
  lastSyncedAt?: Date | null;
  errorMessage?: string | null;
  autoRefresh?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export class LinkedFileEntity {
  public readonly id: string;
  public readonly projectId: string;
  public name: string;
  public readonly provider: LinkedFileProvider;
  public url?: string | null;
  public collectionId?: string | null;
  public nodeId?: string | null;
  public docId?: string | null;
  public fileId?: string | null;
  public status: LinkedFileSyncStatus;
  public lastSyncedAt?: Date | null;
  public errorMessage?: string | null;
  public autoRefresh: boolean;
  public readonly createdAt: Date;
  public updatedAt: Date;

  constructor(props: LinkedFileProps) {
    this.id = props.id;
    this.projectId = props.projectId;
    this.name = props.name;
    this.provider = props.provider;
    this.url = props.url ?? null;
    this.collectionId = props.collectionId ?? null;
    this.nodeId = props.nodeId ?? null;
    this.docId = props.docId ?? null;
    this.fileId = props.fileId ?? null;
    this.status = props.status;
    this.lastSyncedAt = props.lastSyncedAt ?? null;
    this.errorMessage = props.errorMessage ?? null;
    this.autoRefresh = props.autoRefresh ?? false;
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
  }

  public markSynced(nodeId?: string, docId?: string, fileId?: string): void {
    this.status = 'synced';
    this.lastSyncedAt = new Date();
    this.errorMessage = null;
    this.updatedAt = new Date();
    if (nodeId) this.nodeId = nodeId;
    if (docId) this.docId = docId;
    if (fileId) this.fileId = fileId;
  }

  public markFailed(errorMessage: string): void {
    this.status = 'failed';
    this.errorMessage = errorMessage;
    this.updatedAt = new Date();
  }

  public toJSON() {
    return {
      id: this.id,
      projectId: this.projectId,
      name: this.name,
      provider: this.provider,
      url: this.url,
      collectionId: this.collectionId,
      nodeId: this.nodeId,
      docId: this.docId,
      fileId: this.fileId,
      status: this.status,
      lastSyncedAt: this.lastSyncedAt?.toISOString() ?? null,
      errorMessage: this.errorMessage,
      autoRefresh: this.autoRefresh,
      createdAt: this.createdAt.toISOString(),
      updatedAt: this.updatedAt.toISOString(),
    };
  }
}
