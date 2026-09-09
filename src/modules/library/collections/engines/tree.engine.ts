import { Injectable, BadRequestException } from '@nestjs/common';
import { CollectionTreeNode } from '../types/collections.types';
import { RawCollectionItem } from '../utils/collections.utils';

/**
 * CollectionTreeEngine — Deep Module for hierarchical collection processing (Matt Pocock Pattern).
 * Encapsulates tree synthesis, cycle detection (direct & indirect ancestor traversal),
 * and subtree operations behind a concise, pure deterministic interface.
 */
@Injectable()
export class TreeEngine {
  /**
   * Transforms a flat list of collections into a nested recursive tree structure.
   */
  buildTree(collections: RawCollectionItem[]): CollectionTreeNode[] {
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

  /**
   * Detects whether setting `candidateParentId` as parent of `collectionId`
   * would create a direct or indirect cycle in the collection hierarchy.
   */
  detectCycle(
    existingCollections: RawCollectionItem[],
    collectionId: string,
    candidateParentId: string,
  ): boolean {
    if (!collectionId || !candidateParentId) return false;
    if (collectionId === candidateParentId) return true;

    const parentLookup = new Map<string, string | null | undefined>();
    for (const c of existingCollections) {
      parentLookup.set(c.id, c.parentId);
    }

    // Traverse upwards from candidateParentId to root
    const visited = new Set<string>();
    let current: string | null | undefined = candidateParentId;

    while (current) {
      if (current === collectionId) {
        return true; // Cycle detected: candidateParentId is a descendant of collectionId
      }
      if (visited.has(current)) {
        break; // Guard against pre-existing cycles
      }
      visited.add(current);
      current = parentLookup.get(current);
    }

    return false;
  }

  /**
   * Asserts that setting `candidateParentId` does not introduce a cycle.
   * Throws BadRequestException if a cycle is detected.
   */
  assertNoCycle(
    existingCollections: RawCollectionItem[],
    collectionId: string,
    candidateParentId: string,
  ): void {
    if (this.detectCycle(existingCollections, collectionId, candidateParentId)) {
      throw new BadRequestException(
        `Circular collection hierarchy detected: collection ${collectionId} cannot be a descendant of itself`,
      );
    }
  }

  /**
   * Retrieves all descendant collection IDs for a given root collection ID.
   */
  getDescendantIds(
    collections: RawCollectionItem[],
    rootId: string,
  ): string[] {
    const childrenMap = new Map<string, string[]>();
    for (const c of collections) {
      if (c.parentId) {
        const existing = childrenMap.get(c.parentId) || [];
        existing.push(c.id);
        childrenMap.set(c.parentId, existing);
      }
    }

    const descendants: string[] = [];
    const queue: string[] = [...(childrenMap.get(rootId) || [])];

    while (queue.length > 0) {
      const current = queue.shift()!;
      descendants.push(current);
      const nextChildren = childrenMap.get(current);
      if (nextChildren && nextChildren.length > 0) {
        queue.push(...nextChildren);
      }
    }

    return descendants;
  }
}

export { TreeEngine as CollectionTreeEngine };
