declare const _brand: unique symbol;
export type Brand<T, TBrand extends string> = T & { readonly [_brand]: TBrand };

export type StateId = Brand<string, 'StateId'>;
export type UserId = Brand<string, 'UserId'>;
export type ItemId = Brand<string, 'ItemId'>;

export enum ReadingStatus {
  UNREAD = 'unread',
  READING = 'reading',
  COMPLETED = 'completed',
}

export const READING_STATUS = {
  UNREAD: 'unread',
  READING: 'reading',
  COMPLETED: 'completed',
} as const;

export type ReadingStatusValue =
  (typeof READING_STATUS)[keyof typeof READING_STATUS];

export type ReadStatus = ReadingStatus;
export const ReadStatus = ReadingStatus;

export type StateStatus = ReadingStatus;
export const StateStatus = ReadingStatus;

export interface StateEntity {
  id?: string;
  userId: string;
  itemId: string;
  isStarred?: boolean;
  readStatus: ReadingStatus | string;
  rating: number | null;
  currentPage: number | null;
  scrollPosition: unknown;
  lastOpenedAt: Date | null;
  lastReadAt: Date | null;
  updatedAt: Date;
}

export interface StateData {
  isStarred?: boolean;
  readStatus: ReadingStatus;
  rating: number;
  currentPage: number;
  scrollPosition: Record<string, unknown> | Array<unknown> | null;
  lastOpenedAt: string | null;
  lastReadAt: string | null;
}

export type ItemState = StateData;
export type ReadingState = StateData;

export interface UpsertStateData {
  isStarred?: boolean;
  readStatus?: ReadingStatus;
  rating?: number;
  currentPage?: number;
  scrollPosition?: Record<string, unknown> | Array<unknown> | null;
  lastOpenedAt?: Date | null;
  lastReadAt?: Date | null;
}

export const VALID_READING_TRANSITIONS: Record<
  ReadingStatus,
  readonly ReadingStatus[]
> = {
  [ReadingStatus.UNREAD]: [ReadingStatus.READING, ReadingStatus.COMPLETED],
  [ReadingStatus.READING]: [ReadingStatus.COMPLETED, ReadingStatus.UNREAD],
  [ReadingStatus.COMPLETED]: [ReadingStatus.READING, ReadingStatus.UNREAD],
};

export const VALID_STATE_TRANSITIONS = VALID_READING_TRANSITIONS;

export type StateResult =
  | { success: true; data: StateData }
  | {
      success: false;
      code: 'NOT_FOUND' | 'INVALID_TRANSITION' | 'FORBIDDEN';
      message: string;
    };
