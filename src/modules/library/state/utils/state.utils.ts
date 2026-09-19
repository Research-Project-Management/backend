import {
  StateData,
  ReadingStatus,
  VALID_STATE_TRANSITIONS,
} from '../types/state.types';

/**
 * Validates whether transition from current status to next status is permitted.
 */
export function isValidStateTransition(
  current: ReadingStatus,
  next: ReadingStatus,
): boolean {
  if (current === next) return true;
  return VALID_STATE_TRANSITIONS[current]?.includes(next) ?? false;
}

export const isValidReadingTransition = isValidStateTransition;

/**
 * Validates whether user rating is in allowed bounds (0 = unrated, 1..5 stars).
 */
export function isValidRating(rating?: number | null): boolean {
  if (rating === undefined || rating === null) return true;
  return Number.isInteger(rating) && rating >= 0 && rating <= 5;
}

/**
 * Validates whether currentPage is a positive integer (1-based).
 */
export function isValidCurrentPage(page?: number | null): boolean {
  if (page === undefined || page === null) return true;
  return Number.isInteger(page) && page >= 1;
}

/**
 * Pure domain rule:
 * If an item is unread, but the user has advanced past page 1 or set a scroll position,
 * the status should automatically advance to 'reading'.
 */
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

/**
 * Safely converts Date, ISO string, or null into an ISO string or null without throwing.
 */
export function formatStateDate(val?: unknown): string | null {
  if (!val) return null;
  if (val instanceof Date) return val.toISOString();
  if (typeof val === 'string') {
    const d = new Date(val);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

/**
 * Validates whether scrollPosition is within safe size and structural limits (max 16KB).
 */
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

/**
 * Normalizes raw database state or null into standard StateData response object.
 */
export function toStateResponse(
  state?: {
    readStatus?: string;
    rating?: number | null;
    currentPage?: number | null;
    scrollPosition?: unknown;
    lastOpenedAt?: Date | string | null;
    lastReadAt?: Date | string | null;
  } | null,
): StateData {
  return {
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

export const toReadingStateResponse = toStateResponse;
