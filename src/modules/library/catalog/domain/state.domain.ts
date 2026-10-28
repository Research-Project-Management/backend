import {
  StateData,
  ReadingStatus,
  VALID_READING_TRANSITIONS,
} from '@/modules/library/catalog/types/state.types';

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
  readStatus: 'completed' | 'reading' | 'skimmed' | 'unread';
  maxCurrentPage: number | null;
  latestScroll: unknown;
  latestOpenedAt: Date | null;
  latestReadAt: Date | null;
}

export function pickPreferredMergedState(
  states: ReadonlyArray<MergeableUserItemState>,
): PreferredMergedState {
  const positiveRatings = states
    .map((s) => s.rating)
    .filter((r): r is number => typeof r === 'number' && r > 0);
  const maxRating: number | null =
    positiveRatings.length > 0
      ? Math.max(...positiveRatings)
      : states.length > 0 && states.every((s) => s.rating === 0)
        ? 0
        : null;
  const isStarred = states.some((s) => Boolean(s.isStarred));
  const isCompleted = states.some((s) => s.readStatus === 'completed');
  const isReading = states.some((s) => s.readStatus === 'reading');
  const isSkimmed = states.some((s) => s.readStatus === 'skimmed');
  const readStatus = isCompleted
    ? 'completed'
    : isReading
      ? 'reading'
      : isSkimmed
        ? 'skimmed'
        : 'unread';

  const latestReadAt =
    states
      .map((s) => s.lastReadAt)
      .filter((d): d is Date => d instanceof Date)
      .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;

  const latestOpenedAt =
    states
      .map((s) => s.lastOpenedAt)
      .filter((d): d is Date => d instanceof Date)
      .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;

  const validPages = states
    .map((s) => s.currentPage)
    .filter((p): p is number => typeof p === 'number' && p > 0);
  const maxCurrentPage =
    validPages.length > 0 ? Math.max(...validPages) : null;
  const statesWithScroll = states.filter(
    (s) => s.scrollPosition !== null && s.scrollPosition !== undefined,
  );
  statesWithScroll.sort((a, b) => {
    const readA = a.lastReadAt ? a.lastReadAt.getTime() : 0;
    const readB = b.lastReadAt ? b.lastReadAt.getTime() : 0;
    if (readB !== readA) return readB - readA;

    const openA = a.lastOpenedAt ? a.lastOpenedAt.getTime() : 0;
    const openB = b.lastOpenedAt ? b.lastOpenedAt.getTime() : 0;
    if (openB !== openA) return openB - openA;

    return (b.currentPage || 1) - (a.currentPage || 1);
  });
  const latestScroll = statesWithScroll[0]?.scrollPosition;

  return {
    isStarred,
    maxRating,
    readStatus,
    maxCurrentPage,
    latestScroll,
    latestOpenedAt,
    latestReadAt,
  };
}
