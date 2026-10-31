import { Injectable, BadRequestException } from '@nestjs/common';
import { CollectionTreeNode } from '@/modules/library/catalog/types/catalog.types';

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
 * Sanitizes collection name string:
 * - Strips script and style tags and contents
 * - Strips all HTML tags
 * - Strips control characters
 * - Collapses whitespace and trims
 * - Maximum length 255 characters
 */
export function sanitizeCollectionName(name?: string | null): string {
  if (!name || typeof name !== 'string') return '';
  let cleaned = name.trim();
  cleaned = cleaned.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  cleaned = cleaned.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  cleaned = cleaned.replace(/<[^>]+>/g, '');
  // eslint-disable-next-line no-control-regex
  cleaned = cleaned.replace(/[\x00-\x1F\x7F]/g, '');
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  if (cleaned.length > 255) {
    cleaned = cleaned.substring(0, 255).trim();
  }
  return cleaned;
}

/**
 * Sanitizes collection description string:
 * - Strips script and style tags and contents
 * - Strips dangerous HTML tags
 * - Strips control characters
 * - Collapses excessive whitespace and trims
 * - Maximum length 1000 characters
 */
export function sanitizeCollectionDescription(
  description?: string | null,
): string {
  if (!description || typeof description !== 'string') return '';
  let cleaned = description.trim();
  cleaned = cleaned.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  cleaned = cleaned.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  cleaned = cleaned.replace(/<[^>]+>/g, '');
  // eslint-disable-next-line no-control-regex
  cleaned = cleaned.replace(/[\x00-\x1F\x7F]/g, '');
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  if (cleaned.length > 1000) {
    cleaned = cleaned.substring(0, 1000).trim();
  }
  return cleaned;
}

/**
 * TreeEngine — Deep Module for hierarchical collection processing.
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

    const computeRecursiveCounts = (node: CollectionTreeNode): number => {
      let sum = node.itemCount;
      for (const child of node.children) {
        sum += computeRecursiveCounts(child);
      }
      node.recursiveItemCount = sum;
      return sum;
    };

    for (const root of roots) {
      computeRecursiveCounts(root);
    }

    return roots;
  }

  /**
   * Detects whether setting `candidateParentId` as parent of `collectionId`
   * would create a direct or indirect cycle in the collection hierarchy.
   */
  detectCycle(
    existingCollections: Array<Pick<RawCollectionItem, 'id' | 'parentId'>>,
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
    existingCollections: Array<Pick<RawCollectionItem, 'id' | 'parentId'>>,
    collectionId: string,
    candidateParentId: string,
  ): void {
    if (
      this.detectCycle(existingCollections, collectionId, candidateParentId)
    ) {
      throw new BadRequestException(
        `Circular collection hierarchy detected: collection ${collectionId} cannot be a descendant of itself`,
      );
    }
  }

  /**
   * Retrieves all descendant collection IDs for a given root collection ID.
   * Cycle-safe: Uses a visited set and index-based BFS queue to prevent infinite loops
   * and achieve optimal O(V + E) performance without array shifts.
   */
  getDescendantIds(
    collections: Array<Pick<RawCollectionItem, 'id' | 'parentId'>>,
    rootId: string,
  ): string[] {
    const childrenMap = new Map<string, string[]>();
    for (const c of collections) {
      if (c.parentId) {
        let existing = childrenMap.get(c.parentId);
        if (!existing) {
          existing = [];
          childrenMap.set(c.parentId, existing);
        }
        existing.push(c.id);
      }
    }

    const visited = new Set<string>([rootId]);
    const descendants: string[] = [];
    const queue: string[] = [];

    const rootChildren = childrenMap.get(rootId);
    if (rootChildren) {
      for (const childId of rootChildren) {
        if (!visited.has(childId)) {
          visited.add(childId);
          queue.push(childId);
        }
      }
    }

    let head = 0;
    while (head < queue.length) {
      const current = queue[head++];
      descendants.push(current);
      const nextChildren = childrenMap.get(current);
      if (nextChildren) {
        for (const childId of nextChildren) {
          if (!visited.has(childId)) {
            visited.add(childId);
            queue.push(childId);
          }
        }
      }
    }

    return descendants;
  }
}
