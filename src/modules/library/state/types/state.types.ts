import { Prisma, ReadStatus } from '@prisma/client';

// ─── Branded ID Types (Matt Pocock Pattern) ──────────────────────────────────
declare const _brand: unique symbol;
export type Brand<T, TBrand extends string> = T & { readonly [_brand]: TBrand };

export type StateId = Brand<string, 'StateId'>;
export type UserId = Brand<string, 'UserId'>;
export type ItemId = Brand<string, 'ItemId'>;

// ─── Reading Status Enum & Const ─────────────────────────────────────────────
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

export type StateStatus = ReadingStatus;
export const StateStatus = ReadingStatus;

// ─── StateEntity — Prisma-Inferred (Matt Pocock Pattern) ─────────────────────
const stateSelect = {
  id: true,
  userId: true,
  itemId: true,
  readStatus: true,
  rating: true,
  currentPage: true,
  scrollPosition: true,
  lastOpenedAt: true,
  lastReadAt: true,
  updatedAt: true,
} satisfies Prisma.StateSelect;

export type StateEntity = Prisma.StateGetPayload<{
  select: typeof stateSelect;
}>;

// ─── State Data & Response Shapes ─────────────────────────────────────────────
export interface StateData {
  readStatus: ReadingStatus;
  rating: number;
  currentPage: number;
  scrollPosition: Record<string, unknown> | Array<unknown> | null;
  lastOpenedAt: string | null;
  lastReadAt: string | null;
}

export type ItemState = StateData;
export type ReadingState = StateData;

// ─── Repository Upsert Input ──────────────────────────────────────────────────
export interface UpsertStateData {
  readStatus?: ReadingStatus;
  rating?: number;
  currentPage?: number;
  scrollPosition?: Record<string, unknown> | Array<unknown> | null;
  lastOpenedAt?: Date | null;
  lastReadAt?: Date | null;
}

// ─── State Machine Transitions ───────────────────────────────────────────────
export const VALID_READING_TRANSITIONS: Record<
  ReadingStatus,
  readonly ReadingStatus[]
> = {
  [ReadingStatus.UNREAD]: [ReadingStatus.READING, ReadingStatus.COMPLETED],
  [ReadingStatus.READING]: [ReadingStatus.COMPLETED, ReadingStatus.UNREAD],
  [ReadingStatus.COMPLETED]: [ReadingStatus.READING, ReadingStatus.UNREAD],
};

export const VALID_STATE_TRANSITIONS = VALID_READING_TRANSITIONS;

// ─── Service Discriminated Union ─────────────────────────────────────────────
export type StateResult =
  | { success: true; data: StateData }
  | {
      success: false;
      code: 'NOT_FOUND' | 'INVALID_TRANSITION' | 'FORBIDDEN';
      message: string;
    };
