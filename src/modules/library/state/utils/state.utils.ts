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
 * Normalizes raw database state into standard StateData response object.
 */
export function toStateResponse(
  state?: {
    readStatus: string;
    rating: number | null;
    lastReadAt: Date | null;
  } | null,
): StateData {
  return {
    readStatus: (state?.readStatus as ReadingStatus) ?? ReadingStatus.UNREAD,
    rating: state?.rating ?? 0,
    lastReadAt: state?.lastReadAt ? state.lastReadAt.toISOString() : null,
  };
}

export const toReadingStateResponse = toStateResponse;
