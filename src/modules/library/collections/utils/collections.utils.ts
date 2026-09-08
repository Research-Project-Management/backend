import { CollectionTreeNode } from '../types/collections.types';

export interface RawCollectionItem {
  id: string;
  name: string;
  description?: string | null;
  color?: string | null;
  icon?: string | null;
  parentId?: string | null;
  itemCount?: number;
  _count?: { collectionItems?: number };
}

/**
 * Normalizes parent ID string, treating 'root', empty string, or undefined as null.
 */
export function normalizeParentId(rawParentId?: unknown): string | null {
  if (typeof rawParentId !== 'string') return null;
  const str = rawParentId.trim();
  if (str === '' || str.toLowerCase() === 'root') return null;
  return str;
}

/**
 * Transforms a flat list of collections into a nested recursive tree structure.
 */
export function buildCollectionTree(
  collections: RawCollectionItem[],
): CollectionTreeNode[] {
  const map = new Map<string, CollectionTreeNode>();

  for (const c of collections) {
    map.set(c.id, {
      id: c.id,
      name: c.name,
      description: c.description,
      color: c.color,
      icon: c.icon,
      parentId: c.parentId,
      itemCount: c.itemCount ?? c._count?.collectionItems ?? 0,
      children: [],
    });
  }

  const roots: CollectionTreeNode[] = [];
  for (const node of map.values()) {
    if (node.parentId && map.has(node.parentId)) {
      map.get(node.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}
