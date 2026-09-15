import { StorageNode } from '../entities/storage-node.entity';
import { FileScope } from '../value-objects/file-scope.vo';

export interface ListDriveFilter {
  userId?: string;
  parentId?: string | null;
  scope?: FileScope;
  projectId?: string | null;
  starredOnly?: boolean;
  trashedOnly?: boolean;
  authorId?: string;
  limit?: number;
  offset?: number;
}

export interface IStorageNodeRepository {
  findById(id: string): Promise<StorageNode | null>;
  create(node: StorageNode): Promise<StorageNode>;
  update(node: StorageNode): Promise<StorageNode>;
  delete(id: string): Promise<void>;
  deleteMany(ids: string[]): Promise<void>;
  list(
    filter: ListDriveFilter,
  ): Promise<{ nodes: StorageNode[]; total: number }>;
  findByBlobId(blobId: string): Promise<StorageNode[]>;
  softDeleteSubtree(rootNodeId: string): Promise<number>;
  restoreSubtree(rootNodeId: string): Promise<number>;
  findExpiredTrash(daysOld: number, limit: number): Promise<StorageNode[]>;
}
