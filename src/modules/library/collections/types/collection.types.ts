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
