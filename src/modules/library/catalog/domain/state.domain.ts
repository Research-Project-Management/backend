import { StateData, ReadingStatus, VALID_READING_TRANSITIONS, CollectionTreeNode } from '@/modules/library/catalog/types/catalog.types';
import { Injectable, BadRequestException } from '@nestjs/common';
import { collectDescendantCollectionIds } from '@/modules/library/core';

export function isValidStateTransition(
  current: ReadingStatus,
  next: ReadingStatus,
): boolean {
  if (current === next) return true;
  return VALID_READING_TRANSITIONS[current]?.includes(next) ?? false;
}

export function isValidRating(rating?: number | null): boolean {
  if (rating === undefined || rating === null) return true;
  return Number.isInteger(rating) && rating >= 0 && rating <= 5;
}

export function isValidCurrentPage(page?: number | null): boolean {
  if (page === undefined || page === null) return true;
  return Number.isInteger(page) && page >= 1;
}

export function shouldAutoAdvanceToReading(
  currentStatus: ReadingStatus,
  targetPage?: number | null,
  scrollPosition?: unknown,
): boolean {
  if (currentStatus !== ReadingStatus.UNREAD) return false;
  const advancedPage =
    targetPage !== undefined && targetPage !== null && targetPage > 1;
  const hasScroll = scrollPosition !== undefined && scrollPosition !== null;
  return advancedPage || hasScroll;
}

const MAX_SCROLL_POSITION_BYTES = 16384; // 16 KB

export function formatStateDate(val?: unknown): string | null {
  if (!val) return null;
  if (val instanceof Date) return val.toISOString();
  if (typeof val === 'string') {
    const d = new Date(val);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

export function isValidScrollPosition(scrollPosition: unknown): boolean {
  if (scrollPosition === undefined || scrollPosition === null) return true;
  if (typeof scrollPosition !== 'object') return false;
  try {
    const serialized = JSON.stringify(scrollPosition);
    if (!serialized) return false;
    return Buffer.byteLength(serialized, 'utf8') <= MAX_SCROLL_POSITION_BYTES;
  } catch {
    return false;
  }
}

export function mergeScrollPosition(
  existingScroll: unknown,
  incomingScroll: unknown,
  attachmentId?: string,
): Record<string, unknown> | Array<unknown> | null | undefined {
  if (incomingScroll === undefined) {
    return undefined;
  }
  if (incomingScroll === null) {
    return null;
  }
  if (Array.isArray(incomingScroll)) {
    return incomingScroll;
  }
  if (typeof incomingScroll === 'object') {
    const incomingObj = incomingScroll as Record<string, unknown>;
    const existingObj =
      existingScroll &&
      typeof existingScroll === 'object' &&
      !Array.isArray(existingScroll)
        ? (existingScroll as Record<string, unknown>)
        : {};
    const merged: Record<string, unknown> = {
      ...existingObj,
      ...incomingObj,
    };

    const resolvedAttId =
      attachmentId?.trim() ||
      (typeof incomingObj.attachmentId === 'string' &&
      incomingObj.attachmentId.trim()
        ? incomingObj.attachmentId.trim()
        : undefined);

    if (resolvedAttId) {
      const existingByAtt =
        existingObj.byAttachment &&
        typeof existingObj.byAttachment === 'object' &&
        !Array.isArray(existingObj.byAttachment)
          ? (existingObj.byAttachment as Record<string, Record<string, unknown>>)
          : {};
      const incomingByAtt =
        incomingObj.byAttachment &&
        typeof incomingObj.byAttachment === 'object' &&
        !Array.isArray(incomingObj.byAttachment)
          ? (incomingObj.byAttachment as Record<string, Record<string, unknown>>)
          : {};
      const { byAttachment: _ignoreByAtt, ...perAttFields } = incomingObj;
      merged.byAttachment = {
        ...existingByAtt,
        ...incomingByAtt,
        [resolvedAttId]: {
          ...(existingByAtt[resolvedAttId] || {}),
          ...(incomingByAtt[resolvedAttId] || {}),
          ...perAttFields,
        },
      };
    }

    return merged;
  }
  return incomingScroll as Record<string, unknown>;
}

export function toStateResponse(
  state?: {
    isStarred?: boolean;
    readStatus?: string;
    rating?: number | null;
    currentPage?: number | null;
    scrollPosition?: unknown;
    lastOpenedAt?: Date | string | null;
    lastReadAt?: Date | string | null;
  } | null,
): StateData {
  return {
    isStarred: Boolean(state?.isStarred),
    readStatus: (state?.readStatus as ReadingStatus) ?? ReadingStatus.UNREAD,
    rating: state?.rating ?? 0,
    currentPage: state?.currentPage ?? 1,
    scrollPosition:
      state?.scrollPosition !== undefined && state?.scrollPosition !== null
        ? (state.scrollPosition as Record<string, unknown> | Array<unknown>)
        : null,
    lastOpenedAt: formatStateDate(state?.lastOpenedAt),
    lastReadAt: formatStateDate(state?.lastReadAt),
  };
}

interface MergeableUserItemState {
  userId: string;
  itemId: string;
  isStarred?: boolean | null;
  rating?: number | null;
  readStatus?: string | null;
  currentPage?: number | null;
  scrollPosition?: unknown;
  lastOpenedAt?: Date | null;
  lastReadAt?: Date | null;
}

interface PreferredMergedState {
  isStarred: boolean;
  maxRating: number | null;
  readStatus: 'completed' | 'reading' | 'unread';
  maxCurrentPage: number | null;
  latestScroll: unknown;
  latestOpenedAt: Date | null;
  latestReadAt: Date | null;
}

const STATUS_RANK: Readonly<Record<string, 0 | 1 | 2>> = {
  unread: 0,
  reading: 1,
  completed: 2,
};

const RANK_TO_STATUS = ['unread', 'reading', 'completed'] as const;

/**
 * Single-pass $O(N)$ Finite Lattice Join over user item states.
 */
export function pickPreferredMergedState(
  states: ReadonlyArray<MergeableUserItemState>,
): PreferredMergedState {
  let isStarred = false;
  let maxPosRating = 0;
  let allZeroRating = states.length > 0;
  let maxStatusRank: 0 | 1 | 2 = 0;
  let maxCurrentPage: number | null = null;
  let latestReadAt: Date | null = null;
  let latestReadTs = -Infinity;
  let latestOpenedAt: Date | null = null;
  let latestOpenedTs = -Infinity;

  let latestScroll: unknown = undefined;
  let bestScrollReadTs = -1;
  let bestScrollOpenTs = -1;
  let bestScrollPage = -Infinity;
  const bookmarkMap = new Map<number, unknown>();
  const mergedByAttachment: Record<string, Record<string, unknown>> = {};
  let hasByAttachment = false;

  for (const s of states) {
    if (s.isStarred) isStarred = true;

    if (typeof s.rating === 'number' && s.rating > 0) {
      if (s.rating > maxPosRating) maxPosRating = s.rating;
      allZeroRating = false;
    } else if (s.rating !== 0) {
      allZeroRating = false;
    }

    const rank = s.readStatus ? (STATUS_RANK[s.readStatus] ?? 0) : 0;
    if (rank > maxStatusRank) maxStatusRank = rank;

    if (
      typeof s.currentPage === 'number' &&
      s.currentPage > 0 &&
      (maxCurrentPage === null || s.currentPage > maxCurrentPage)
    ) {
      maxCurrentPage = s.currentPage;
    }

    const readTs = s.lastReadAt instanceof Date ? s.lastReadAt.getTime() : 0;
    if (s.lastReadAt instanceof Date && readTs > latestReadTs) {
      latestReadTs = readTs;
      latestReadAt = s.lastReadAt;
    }

    const openTs =
      s.lastOpenedAt instanceof Date ? s.lastOpenedAt.getTime() : 0;
    if (s.lastOpenedAt instanceof Date && openTs > latestOpenedTs) {
      latestOpenedTs = openTs;
      latestOpenedAt = s.lastOpenedAt;
    }

    if (s.scrollPosition !== null && s.scrollPosition !== undefined) {
      if (
        typeof s.scrollPosition === 'object' &&
        !Array.isArray(s.scrollPosition)
      ) {
        const spObj = s.scrollPosition as Record<string, unknown>;
        if (Array.isArray(spObj.bookmarks)) {
          for (const bm of spObj.bookmarks) {
            const pageNum =
              typeof bm === 'number'
                ? bm
                : bm &&
                    typeof bm === 'object' &&
                    typeof (bm as { page?: unknown }).page === 'number'
                  ? (bm as { page: number }).page
                  : null;
            if (pageNum !== null && Number.isFinite(pageNum) && pageNum >= 1) {
              const existingBm = bookmarkMap.get(pageNum);
              if (
                existingBm === undefined ||
                (typeof existingBm === 'number' && typeof bm === 'object')
              ) {
                bookmarkMap.set(pageNum, bm);
              }
            }
          }
        }
        if (
          spObj.byAttachment &&
          typeof spObj.byAttachment === 'object' &&
          !Array.isArray(spObj.byAttachment)
        ) {
          for (const [attId, attState] of Object.entries(
            spObj.byAttachment as Record<string, unknown>,
          )) {
            if (
              attState &&
              typeof attState === 'object' &&
              !Array.isArray(attState)
            ) {
              hasByAttachment = true;
              mergedByAttachment[attId] = {
                ...(mergedByAttachment[attId] || {}),
                ...(attState as Record<string, unknown>),
              };
            }
          }
        }
      }

      const page = s.currentPage || 1;
      const isBetterScroll =
        latestScroll === undefined ||
        readTs > bestScrollReadTs ||
        (readTs === bestScrollReadTs &&
          (openTs > bestScrollOpenTs ||
            (openTs === bestScrollOpenTs && page > bestScrollPage)));
      if (isBetterScroll) {
        latestScroll = s.scrollPosition;
        bestScrollReadTs = readTs;
        bestScrollOpenTs = openTs;
        bestScrollPage = page;
      }
    }
  }

  if (
    latestScroll &&
    typeof latestScroll === 'object' &&
    !Array.isArray(latestScroll) &&
    (bookmarkMap.size > 0 || hasByAttachment)
  ) {
    const unionedBookmarks = Array.from(bookmarkMap.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, val]) => val);
    latestScroll = {
      ...(latestScroll as Record<string, unknown>),
      ...(bookmarkMap.size > 0 ? { bookmarks: unionedBookmarks } : {}),
      ...(hasByAttachment ? { byAttachment: mergedByAttachment } : {}),
    };
  }

  return {
    isStarred,
    maxRating: maxPosRating > 0 ? maxPosRating : allZeroRating ? 0 : null,
    readStatus: RANK_TO_STATUS[maxStatusRank],
    maxCurrentPage,
    latestScroll,
    latestOpenedAt,
    latestReadAt,
  };
}

interface RawCollectionItem {
  id: string;
  name: string;
  description?: string | null;
  color?: string | null;
  icon?: string | null;
  parentId?: string | null;
  itemCount?: number;
  _count?: { collectionItems?: number };
  collectionItems?: Array<{ itemId?: string } | string>;
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
    const directItemIdsByCol = new Map<string, string[]>();
    let hasItemIdSets = false;

    for (const c of collections) {
      if (Array.isArray(c.collectionItems)) {
        hasItemIdSets = true;
        const ids: string[] = [];
        for (const entry of c.collectionItems) {
          const itemId = typeof entry === 'string' ? entry : entry?.itemId;
          if (itemId) ids.push(itemId);
        }
        directItemIdsByCol.set(c.id, ids);
      }
      const directCount =
        c.itemCount ??
        c._count?.collectionItems ??
        directItemIdsByCol.get(c.id)?.length ??
        0;
      map.set(c.id, {
        id: c.id,
        name: c.name,
        description: c.description,
        color: c.color,
        icon: c.icon,
        parentId: c.parentId,
        itemCount: directCount,
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

    if (hasItemIdSets) {
      const computeRecursiveSet = (node: CollectionTreeNode): Set<string> => {
        const union = new Set<string>(directItemIdsByCol.get(node.id) ?? []);
        let fallbackAdditive = directItemIdsByCol.has(node.id)
          ? 0
          : node.itemCount;
        for (const child of node.children) {
          const childSet = computeRecursiveSet(child);
          for (const id of childSet) {
            union.add(id);
          }
          if (!directItemIdsByCol.has(child.id) && childSet.size === 0) {
            fallbackAdditive += child.recursiveItemCount ?? child.itemCount;
          }
        }
        node.recursiveItemCount = union.size + fallbackAdditive;
        return union;
      };

      for (const root of roots) {
        computeRecursiveSet(root);
      }
    } else {
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
    return collectDescendantCollectionIds(collections, rootId);
  }
}
