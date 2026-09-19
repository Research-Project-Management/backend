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
