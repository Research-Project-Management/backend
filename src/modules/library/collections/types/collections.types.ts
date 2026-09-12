export type {
  CollectionId,
  WorkspaceId,
} from '../../../../core/types/brand.type';

export type CollectionDeleteStrategy = 'cascade' | 'move-to-parent' | 'orphan';

export interface CollectionTreeNode {
  id: string;
  name: string;
  description?: string | null;
  color?: string | null;
  icon?: string | null;
  parentId?: string | null;
  itemCount: number;
  children: CollectionTreeNode[];
}

export interface CollectionDetail {
  id: string;
  workspaceId: string;
  name: string;
  description?: string | null;
  color?: string | null;
  icon?: string | null;
  parentId?: string | null;
  itemsCount: number;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}
