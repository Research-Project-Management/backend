import {
  StateData,
  ReadingStatus,
  VALID_READING_TRANSITIONS,
} from '@/modules/library/catalog/types/catalog.types';

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

export const MAX_SCROLL_POSITION_BYTES = 16384; // 16 KB

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

export interface MergeableUserItemState {
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

export interface PreferredMergedState {
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
