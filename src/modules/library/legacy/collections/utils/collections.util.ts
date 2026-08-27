import { CollectionNode, CollectionView } from '../types/collections.types';

export function buildCollectionTree(
  collections: CollectionView[],
): CollectionNode[] {
  const map = new Map<string, CollectionNode>();
  const roots: CollectionNode[] = [];

  for (const c of collections) {
    map.set(c.id, {
      id: c.id,
      name: c.name,
      description: c.description,
      color: c.color,
      icon: c.icon,
      parentId: c.parentId,
      itemsCount: c.itemsCount,
      depth: 0,
      path: [c.name],
      children: [],
    });
  }

  for (const c of collections) {
    const node = map.get(c.id)!;
    if (c.parentId && map.has(c.parentId)) {
      const parent = map.get(c.parentId)!;
      node.depth = parent.depth + 1;
      node.path = [...parent.path, c.name];
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

export function findSubtreeCollectionIds(
  collectionId: string,
  allCollections: { id: string; parentId?: string | null }[],
): string[] {
  const result: string[] = [collectionId];
  const childrenMap = new Map<string, string[]>();

  for (const c of allCollections) {
    if (c.parentId) {
      const list = childrenMap.get(c.parentId) || [];
      list.push(c.id);
      childrenMap.set(c.parentId, list);
    }
  }

  const queue = [collectionId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const children = childrenMap.get(current) || [];
    for (const childId of children) {
      result.push(childId);
      queue.push(childId);
    }
  }

  return result;
}

export function detectCollectionCycle(
  collectionId: string,
  targetParentId: string | null | undefined,
  allCollections: { id: string; parentId?: string | null; name?: string }[],
): { hasCycle: boolean; cyclePath: string[] } {
  if (!targetParentId) {
    return { hasCycle: false, cyclePath: [] };
  }

  if (collectionId === targetParentId) {
    return {
      hasCycle: true,
      cyclePath: [collectionId, targetParentId],
    };
  }

  const parentMap = new Map(allCollections.map((c) => [c.id, c.parentId]));
  const nameMap = new Map(allCollections.map((c) => [c.id, c.name || c.id]));

  let current: string | null | undefined = targetParentId;
  const path: string[] = [nameMap.get(collectionId) || collectionId];
  const visited = new Set<string>();

  while (current) {
    path.unshift(nameMap.get(current) || current);

    if (current === collectionId) {
      return { hasCycle: true, cyclePath: path };
    }

    if (visited.has(current)) {
      break;
    }
    visited.add(current);
    current = parentMap.get(current);
  }

  return { hasCycle: false, cyclePath: [] };
}
